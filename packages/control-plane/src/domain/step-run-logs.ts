/**
 * The browser's live-tail and archive surface: one endpoint, two uses, same
 * long-poll shape as `/claim` (spec: "Log → long-poll ≤30s dari offset →
 * daftar presigned GET; arsip memakai endpoint yang sama dari offset nol").
 *
 * The control plane never reads a log byte — it reads only the metadata
 * Runner recorded (`log_chunks`), mints one presigned GET per chunk, and
 * hands the browser the URLs. Every byte moves browser ↔ Garage directly
 * (spec: "Byte tidak pernah lewat control plane").
 *
 * One browser tab = one hanging connection (spec: "Satu tab browser = satu
 * koneksi menggantung"), held for up to 30 seconds and polled every second —
 * deliberately `LISTEN/NOTIFY`-free, exactly like `/claim`, because a Runner
 * flushes at most every 1 second, so there is no fresher data to wait on.
 * SSE and WebSocket were rejected for that same reason (see docs/adr).
 */
import { and, eq, gte } from "drizzle-orm";
import type { Id } from "@factory/shared";
import { logChunks, runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { NotFoundError } from "./errors.js";
import { requireProjectMembership } from "./projects.js";
import type { Principal } from "./principal.js";
import { countWaitingQuestions } from "./step-run-questions.js";

export const LIVE_TAIL_HOLD_MS = 30_000; // spec: "long-poll ≤30s dari offset".
const POLL_INTERVAL_MS = 1000; // spec's hold implementation: "poll ... tiap 1 detik per koneksi menggantung".

const TERMINAL_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "skipped"]);

export interface LogTailChunk {
  seq: number;
  byteOffset: number;
  size: number;
  blobKey: string;
}

export interface ReadLogChunksInput {
  /** Which attempt's log to read. Defaults to the StepRun's current attempt column — live behavior. */
  attempt?: number;
  /** Read from this seq onward. `0` is the archive read. */
  offset: number;
}

export interface LogTailResult {
  /** New chunks with `seq >= offset`, ascending, each with a freshly-minted 5-minute presigned GET. */
  chunks: { seq: number; byteOffset: number; size: number; getUrl: string; expiresAt: Date }[];
  /** The next poll's `offset` — the last seq returned plus one, or the requested offset when nothing was returned. */
  nextOffset: number;
  /** The attempt actually read — the requested one, or the StepRun's current one. */
  attempt: number;
  /** True once the StepRun has ended: nothing more can arrive, the browser should stop polling. */
  ended: boolean;
  /** The same state-derived badge carried by every long-poll response. */
  waitingQuestionCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StepRunWithProject {
  stepRunId: Id<"steprun">;
  projectId: Id<"project">;
  attempt: number;
  outcome: string;
}

async function loadStepRunWithProject(
  deps: Pick<AppDeps, "db">,
  stepRunId: Id<"steprun">,
): Promise<StepRunWithProject> {
  const [row] = await deps.db
    .select({ stepRunId: stepRuns.id, projectId: runs.projectId, attempt: stepRuns.attempt, outcome: stepRuns.outcome })
    .from(stepRuns)
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(eq(stepRuns.id, stepRunId));
  if (!row) {
    throw new NotFoundError("step run", stepRunId);
  }
  return row;
}

async function queryChunks(
  deps: Pick<AppDeps, "db">,
  stepRunId: Id<"steprun">,
  attempt: number,
  offset: number,
): Promise<LogTailChunk[]> {
  const rows = await deps.db
    .select()
    .from(logChunks)
    .where(and(eq(logChunks.stepRunId, stepRunId), eq(logChunks.attempt, attempt), gte(logChunks.seq, offset)))
    .orderBy(logChunks.seq);
  return rows.map((row) => ({ seq: row.seq, byteOffset: row.byteOffset, size: row.size, blobKey: row.blobKey }));
}

function isTerminal(outcome: string): boolean {
  return TERMINAL_OUTCOMES.has(outcome);
}

/**
 * Live-tail and archive in one function. Reserves a live-tail slot for the
 * duration of the hold (one tab = one hanging connection; over the cap the
 * route answers 503 + Retry-After — the browser-side mirror of `/claim`'s
 * limiter). Guards on Project membership (the StepRun's Project, resolved
 * through `step_runs.run_id -> runs.project_id`, the same read join
 * `cancelStepRun` uses), then long-polls: returns the moment any chunk with
 * `seq >= offset` exists for the resolved attempt, and returns
 * empty-with-`ended` once the StepRun is terminal.
 */
export async function readLogChunks(
  deps: Pick<AppDeps, "db" | "objectStore" | "liveTailLimiter" | "liveTailHoldMs">,
  principal: Principal,
  stepRunId: Id<"steprun">,
  input: ReadLogChunksInput,
): Promise<LogTailResult> {
  if (!deps.liveTailLimiter.tryAcquire()) {
    throw new LiveTailCapacityError();
  }
  try {
    let stepRun = await loadStepRunWithProject(deps, stepRunId);
    await requireProjectMembership(deps, principal, stepRun.projectId);

    const attempt = input.attempt ?? stepRun.attempt;
    const deadline = Date.now() + deps.liveTailHoldMs;

    for (;;) {
      const chunks = await queryChunks(deps, stepRunId, attempt, input.offset);
      if (chunks.length > 0) {
        const minted = await Promise.all(chunks.map((chunk) => deps.objectStore.mintGetUrl(chunk.blobKey)));
        const waitingQuestionCount = await countWaitingQuestions(deps, principal);
        return {
          chunks: chunks.map((chunk, index) => ({
            seq: chunk.seq,
            byteOffset: chunk.byteOffset,
            size: chunk.size,
            getUrl: minted[index]!.url,
            expiresAt: minted[index]!.expiresAt,
          })),
          nextOffset: chunks[chunks.length - 1]!.seq + 1,
          attempt,
          ended: isTerminal(stepRun.outcome),
          waitingQuestionCount,
        };
      }
      if (isTerminal(stepRun.outcome)) {
        return {
          chunks: [],
          nextOffset: input.offset,
          attempt,
          ended: true,
          waitingQuestionCount: await countWaitingQuestions(deps, principal),
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          chunks: [],
          nextOffset: input.offset,
          attempt,
          ended: false,
          waitingQuestionCount: await countWaitingQuestions(deps, principal),
        };
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      stepRun = await loadStepRunWithProject(deps, stepRunId);
    }
  } finally {
    deps.liveTailLimiter.release();
  }
}

/** Thrown when the hanging-connection cap for live-tail tabs is reached; routes map this to `503` + `Retry-After`. */
export class LiveTailCapacityError extends Error {
  constructor() {
    super("too many hanging live-tail connections");
    this.name = "LiveTailCapacityError";
  }
}
