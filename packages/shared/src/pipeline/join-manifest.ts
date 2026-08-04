import { z } from "zod";

/**
 * The Join manifest — the data a Join Step receives about the fan-out
 * branches it gathers (spec.md, "Semantik eksekusi"; ticket 21:
 * "Join menerima manifest JSON [{ key, repo, branch, sha, outcome, outputs }]
 * dan fetch repo tuan rumahnya sendiri saja — yang lintas repo adalah
 * bacaannya, bukan checkout-nya").
 *
 * The control plane assembles one entry per fan-out branch (per the
 * branches of every fan-out Step in the Join's `after:` list) and hands it
 * to the Runner in the `/claim` payload; the Runner writes it into the
 * sandbox and the Join Step reads it. Cross-repo branches arrive as data —
 * `repo` names the branch's host Repository so the Runner fetches only the
 * branches that share the claimed StepRun's own repo, and leaves the rest
 * as reads, never checkouts (ticket 21).
 *
 * The entry's `key` is the branch Key (CONTEXT.md), unique per fan-out; the
 * exact branch-ref-shape is shared with the Runner via `stepRunBranchName`.
 */
export const joinManifestEntrySchema = z.object({
  key: z.string(),
  /** The branch's host Repository *name* (as `repo:` is written in the definition) — the Runner fetches only entries whose `repo` equals its own. */
  repo: z.string(),
  /** The full git branch name the branch pushed (`run/<run-id>/<step-key>/<branch-key>/t<turn>-a<attempt>`). */
  branch: z.string(),
  /** The branch's pushed head, when it pushed one — null for a branch that never produced a ref. */
  sha: z.string().nullable(),
  /** The branch's current StepRun outcome — a Join is claimable before every branch is terminal (`any`/`min`), so non-terminal outcomes appear here as data. */
  outcome: z.enum([
    "ready",
    "running",
    "awaiting-human",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
  ]),
  /** The branch's structured Output (the `done` arm's `outputs`), when it succeeded — null otherwise. */
  outputs: z.unknown().nullable(),
});
export type JoinManifestEntry = z.infer<typeof joinManifestEntrySchema>;

export const joinManifestSchema = z.array(joinManifestEntrySchema);
export type JoinManifest = z.infer<typeof joinManifestSchema>;
