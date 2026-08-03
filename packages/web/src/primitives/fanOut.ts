import type { StepRunStatus } from "../tokens/status";

/**
 * Rule this exists for (issue 13, resolved answer, §1):
 *
 *   "Kotak fan-out meringkas begitu cabangnya lebih dari delapan. Yang
 *   digambar adalah delapan cabang teratas menurut urutan
 *   `failed → awaiting → unsched → running → sisanya`, lalu satu baris
 *   `…42 cabang lain`."
 *
 * i.e. a fan-out box summarises above eight branches; the branches that are
 * holding the Run back (failed, then awaiting-human, then unscheduled >5min,
 * then still running) are always the ones shown, in that order — the one
 * broken branch must never hide behind forty healthy ones. Below or at
 * eight branches nothing is hidden, but the same priority order still
 * applies so the box reads consistently whether or not it's summarising.
 */

export type FanOutBucket =
  | "failed"
  | "awaiting-human"
  | "unsched"
  | "running"
  | "rest";

const BUCKET_RANK: Record<FanOutBucket, number> = {
  failed: 0,
  "awaiting-human": 1,
  unsched: 2,
  running: 3,
  rest: 4,
};

export interface FanOutBranch {
  /** The Key that names this branch (CONTEXT.md "Key") — never "index". */
  key: string;
  status: StepRunStatus;
  /**
   * True when this `ready` StepRun has gone unscheduled for more than five
   * minutes (issue 13's locked "StepRun yang tidak terjadwal > 5 menit"
   * rule) — the `unsched` bucket. Meaningless for any other status.
   */
  unscheduledOverThreshold?: boolean;
}

export function classifyBranch(branch: FanOutBranch): FanOutBucket {
  if (branch.status === "failed") return "failed";
  if (branch.status === "awaiting-human") return "awaiting-human";
  if (branch.status === "ready" && branch.unscheduledOverThreshold === true) {
    return "unsched";
  }
  if (branch.status === "running") return "running";
  return "rest";
}

/** Above this many branches, the fan-out box summarises (issue 13 §1). */
export const FAN_OUT_SUMMARY_THRESHOLD = 8;

export interface FanOutSummaryResult {
  /** Branches to render, in the locked priority order. */
  shown: FanOutBranch[];
  /** Branches folded into the "…N cabang lain" remainder row. */
  hiddenCount: number;
  isSummarized: boolean;
}

export function summarizeFanOut(
  branches: readonly FanOutBranch[],
): FanOutSummaryResult {
  const sorted = [...branches].sort(
    (a, b) => BUCKET_RANK[classifyBranch(a)] - BUCKET_RANK[classifyBranch(b)],
  );
  const isSummarized = sorted.length > FAN_OUT_SUMMARY_THRESHOLD;
  const shown = isSummarized
    ? sorted.slice(0, FAN_OUT_SUMMARY_THRESHOLD)
    : sorted;
  const hiddenCount = isSummarized
    ? sorted.length - FAN_OUT_SUMMARY_THRESHOLD
    : 0;
  return { shown, hiddenCount, isSummarized };
}
