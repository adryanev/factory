/**
 * Git remote sebagai bus antar step: setiap giliran seorang StepRun berjalan
 * di branch bernama, dan step hilir fetch branch itu (spec: "Nama branch").
 * Satu fungsi, dipakai Runner (untuk tahu apa yang ia push) dan control plane
 * (untuk GC dan verifikasi) — kalau penamaannya lahir di dua tempat, mereka
 * bisa berpisah diam-diam dan hilir fetch cabang yang tidak pernah ada.
 *
 * Bentuk (spec, verbatim):
 *
 *   run/<run-id>/<step-key>/<branch-key>/t<turn>-a<attempt>
 *   run/<run-id>/<step-key>/t<turn>-a<attempt>            # Step tanpa Key
 *
 * Aman sebagai komponen ref git tanpa sanitasi: run-id adalah base32
 * berprefiks (`@factory/shared` id.ts), step-key/branch-key terkendala
 * `[a-z0-9][a-z0-9._-]{0,63}` (pipeline/key.ts), dan turn/attempt integer.
 */
import type { Id } from "../id.js";

export interface StepRunBranchInput {
  runId: Id<"run">;
  stepKey: string;
  /** Null untuk Step non-fan-out — Step tanpa Key tidak menyisipkan segmen. */
  branchKey: string | null;
  turn: number;
  attempt: number;
}

export function stepRunBranchName(input: StepRunBranchInput): string {
  const key = input.branchKey ? `/${input.branchKey}` : "";
  return `run/${input.runId}/${input.stepKey}${key}/t${input.turn}-a${input.attempt}`;
}
