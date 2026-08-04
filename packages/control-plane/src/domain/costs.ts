/**
 * The cost surface (issue 12, spec: "Cost"). Two rules shape everything:
 * "yang tidak ada tidak diperkirakan; yang sudah ditulis tidak dihitung
 * ulang" — an agent that reported no usage is shown as "tidak didukung",
 * never estimated, and a cost written once at StepRun end is never
 * recomputed when the price table changes.
 *
 * Writing:
 *  - `recordStepRunCost` prices the usage the agent reported in its `done`
 *    Output — once, at `/result` commit, inside the same transaction that
 *    commits the terminal StepRun — against the *current* price version, and
 *    stores `price_version` alongside. The `(step_run_id, attempt)` primary
 *    key makes the row insert-only: a retried attempt is a different row,
 *    and the idempotent `/result` replay never re-prices (it returns before
 *    this is called). "Kumulatif lintas attempt" is therefore a plain `SUM`.
 *  - An attempt whose agent reported no usage still gets a row — with
 *    `tokens`/`cost_usd`/`price_version` all NULL — so the per-attempt
 *    breakdown is complete and shows "tidak didukung" rather than a guessed
 *    number.
 *
 * Reading — the three aggregations, on their own endpoints, deliberately
 * not riding any 3-second polling endpoint (spec: "Tiga agregasi saja, di
 * endpoint terpisah yang tidak menumpang poll"):
 *  - per-StepRun, with the per-attempt breakdown (spec: "Biaya per attempt
 *    terlihat ... saat menyelidiki StepRun yang gagal berulang");
 *  - per-Run, including while the Run is in flight (the sum of completed
 *    attempts so far is the running cost — spec: "biaya berjalan tampil
 *    selagi Run berjalan");
 *  - per-Project, explicitly a *lower bound* (spec: "total Project adalah
 *    batas bawah, bukan total"), broken down by `credential_principal_id`
 *    so shared-credential usage is visible (spec: "pemakaian credential
 *    bersama terlihat lewat dua kolom atribusi terpisah").
 *
 * Retention: no sweep touches `step_run_costs` — rows live exactly as long
 * as their Run (spec: "tidak pernah kedaluwarsa, seumur baris Run").
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { UsageReport } from "@factory/shared";
import type { Id } from "@factory/shared";
import type { Database } from "../db/client.js";
import { priceVersions, runs, stepRunCosts, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { NotFoundError } from "./errors.js";
import type { Principal } from "./principal.js";
import { requireProjectMembership } from "./projects.js";
import type { StepRunRow } from "./graph-advance.js";

type CostRow = typeof stepRunCosts.$inferSelect;

/**
 * The pure pricing step: `cost_usd = (input_tokens * in_per_million +
 * output_tokens * out_per_million) / 1_000_000`, rounded to the column's
 * 6-decimal scale. Prices are numeric strings from Postgres; the tokens are
 * the agent's reported integers. This is the *only* place a price is ever
 * multiplied — a display never recomputes (spec: "tidak ada tampilan yang
 * mengalikan ulang").
 */
export function computeCostUsd(
  price: { inputTokenUsdPerMillion: string; outputTokenUsdPerMillion: string },
  usage: UsageReport,
): string {
  const inputCost = usage.input_tokens * Number(price.inputTokenUsdPerMillion);
  const outputCost = usage.output_tokens * Number(price.outputTokenUsdPerMillion);
  return ((inputCost + outputCost) / 1_000_000).toFixed(6);
}

/**
 * The "current" price version — the most recently effective row. Insert-only
 * table (spec), so "current" is just "the latest inserted state", which is
 * what makes a later price change unable to rewrite history.
 */
async function currentPriceVersion(tx: Database): Promise<typeof priceVersions.$inferSelect> {
  const [row] = await tx
    .select()
    .from(priceVersions)
    .orderBy(desc(priceVersions.effectiveAt), desc(priceVersions.version))
    .limit(1);
  if (!row) {
    // Impossible with migration 0007's seed — an empty price table would
    // mean an operator deleted the insert-only table's rows.
    throw new Error("no price_versions row is configured");
  }
  return row;
}

/**
 * Writes one StepRun's cost row for the attempt that just committed — the
 * write-once half of "yang sudah ditulis tidak dihitung ulang". Called from
 * `submitResult`'s transaction; `onConflictDoNothing` is the structural
 * backstop for the idempotent-replay path (a replay returns earlier, so this
 * is normally never reached twice for one attempt).
 *
 * `usage` is the agent's reported token counts, or null when the agent
 * reported none — a null keeps the row (complete per-attempt recording) with
 * the three cost columns NULL, displayed as "tidak didukung".
 */
export async function recordStepRunCost(
  tx: Database,
  row: StepRunRow,
  usage: UsageReport | null,
): Promise<void> {
  if (usage === null) {
    await tx
      .insert(stepRunCosts)
      .values({ stepRunId: row.id, attempt: row.attempt, tokens: null, costUsd: null, priceVersion: null })
      .onConflictDoNothing();
    return;
  }
  const price = await currentPriceVersion(tx);
  await tx
    .insert(stepRunCosts)
    .values({
      stepRunId: row.id,
      attempt: row.attempt,
      tokens: usage,
      costUsd: computeCostUsd(price, usage),
      priceVersion: price.version,
    })
    .onConflictDoNothing();
}

/** One attempt's cost, as the web surface reads it. */
export interface AttemptCost {
  attempt: number;
  /** False when the agent reported no usage — the UI renders "tidak didukung", never an estimate. */
  supported: boolean;
  tokens: { inputTokens: number; outputTokens: number } | null;
  costUsd: string | null;
  priceVersion: string | null;
}

function toAttemptCost(row: CostRow): AttemptCost {
  const tokens = row.tokens as UsageReport | null;
  return {
    attempt: row.attempt,
    supported: tokens !== null && row.costUsd !== null,
    tokens: tokens ? { inputTokens: tokens.input_tokens, outputTokens: tokens.output_tokens } : null,
    costUsd: row.costUsd,
    priceVersion: row.priceVersion,
  };
}

/** Resolves a StepRun's project and enforces membership — the same read gate `step-run-artifacts.ts` uses. */
async function loadStepRunProject(
  deps: Pick<AppDeps, "db">,
  stepRunId: Id<"steprun">,
): Promise<Id<"project">> {
  const [row] = await deps.db
    .select({ projectId: runs.projectId })
    .from(stepRuns)
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(eq(stepRuns.id, stepRunId));
  if (!row) {
    throw new NotFoundError("step run", stepRunId);
  }
  return row.projectId;
}

export interface StepRunCost {
  /** Every attempt that committed a `/result`, ordered low to high — retries are extra rows, never overwrites. */
  attempts: AttemptCost[];
  /** The plain `SUM` across attempts (spec: "kumulatif lintas attempt adalah penjumlahan biasa"). Null when no attempt was priced. */
  totalCostUsd: string | null;
}

/** Per-StepRun cost with the per-attempt breakdown (AC6). */
export async function getStepRunCost(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  stepRunId: Id<"steprun">,
): Promise<StepRunCost> {
  const projectId = await loadStepRunProject(deps, stepRunId);
  await requireProjectMembership(deps, principal, projectId);

  const rows = await deps.db
    .select()
    .from(stepRunCosts)
    .where(eq(stepRunCosts.stepRunId, stepRunId))
    .orderBy(asc(stepRunCosts.attempt));
  const attempts = rows.map(toAttemptCost);

  const [total] = await deps.db
    .select({ total: sql<string>`sum(${stepRunCosts.costUsd})` })
    .from(stepRunCosts)
    .where(eq(stepRunCosts.stepRunId, stepRunId));
  return { attempts, totalCostUsd: total?.total ?? null };
}

export interface RunCost {
  /** The sum of every priced attempt so far — while the Run is in flight this is the *running* cost (AC8). */
  totalCostUsd: string | null;
  supportedAttempts: number;
  unsupportedAttempts: number;
  /** Which Principal's credentials the Run used (spec: "Cost" — attribution lives on the Run). */
  credentialPrincipalId: Id<"user"> | Id<"serviceaccount">;
  /** False while the Run is still in flight — the cancel-button screen reads this for the "biaya berjalan" label (AC8). */
  runEnded: boolean;
}

/** Per-Run cost — one endpoint, works for ended and in-flight Runs alike (AC8). */
export async function getRunCost(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  runId: Id<"run">,
): Promise<RunCost> {
  await requireProjectMembership(deps, principal, projectId);

  const [run] = await deps.db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.projectId, projectId)));
  if (!run) {
    throw new NotFoundError("run", runId);
  }

  const [aggregate] = await deps.db
    .select({
      total: sql<string>`sum(${stepRunCosts.costUsd})`,
      supported: sql<number>`count(${stepRunCosts.costUsd})::int`,
      unsupported: sql<number>`count(*) filter (where ${stepRunCosts.costUsd} is null)::int`,
    })
    .from(stepRunCosts)
    .innerJoin(stepRuns, eq(stepRuns.id, stepRunCosts.stepRunId))
    .where(eq(stepRuns.runId, runId));

  return {
    totalCostUsd: aggregate?.total ?? null,
    supportedAttempts: aggregate?.supported ?? 0,
    unsupportedAttempts: aggregate?.unsupported ?? 0,
    credentialPrincipalId: run.credentialPrincipalId,
    runEnded: run.endedAt !== null,
  };
}

export interface ProjectCostPrincipal {
  credentialPrincipalId: Id<"user"> | Id<"serviceaccount">;
  costUsd: string;
}

export interface ProjectCost {
  /**
   * A *lower bound*, never a total: unsupported agents and in-flight Runs
   * contribute nothing here, and the price table is pinned to what was
   * already written (spec: "total Project adalah batas bawah, bukan total").
   */
  totalCostUsd: string | null;
  lowerBound: true;
  /** The same attribution the Run rows carry, so shared-credential usage is visible (AC9). */
  byCredentialPrincipal: ProjectCostPrincipal[];
}

/** Per-Project cost, explicitly a lower bound, broken down by the credential principal used (AC2/AC9). */
export async function getProjectCost(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<ProjectCost> {
  await requireProjectMembership(deps, principal, projectId);

  const rows = await deps.db
    .select({
      credentialPrincipalId: runs.credentialPrincipalId,
      costUsd: sql<string>`sum(${stepRunCosts.costUsd})`,
    })
    .from(stepRunCosts)
    .innerJoin(stepRuns, eq(stepRuns.id, stepRunCosts.stepRunId))
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(eq(runs.projectId, projectId))
    .groupBy(runs.credentialPrincipalId)
    .orderBy(desc(sql`sum(${stepRunCosts.costUsd})`));

  const byCredentialPrincipal = rows
    .filter((row) => row.costUsd !== null)
    .map((row) => ({
      credentialPrincipalId: row.credentialPrincipalId,
      costUsd: row.costUsd!,
    }));

  const [total] = await deps.db
    .select({ total: sql<string>`sum(${stepRunCosts.costUsd})` })
    .from(stepRunCosts)
    .innerJoin(stepRuns, eq(stepRuns.id, stepRunCosts.stepRunId))
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(eq(runs.projectId, projectId));

  return { totalCostUsd: total?.total ?? null, lowerBound: true, byCredentialPrincipal };
}
