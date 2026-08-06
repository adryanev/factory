/**
 * The cost data the control plane exposes (issue 12) — the wire shapes of
 * the three aggregation endpoints (`routes/costs.ts`), typed here so the
 * primitives render real API data without inventing a schema of their own.
 * Cost is stored once at StepRun end with its `price_version` (numeric
 * strings from Postgres); a null `costUsd` means the agent reported no
 * usage and the UI must show "tidak didukung", never an estimate.
 */

export interface AttemptCostData {
  attempt: number;
  /** False when the agent reported no usage — render "tidak didukung". */
  supported: boolean;
  tokens: { inputTokens: number; outputTokens: number } | null;
  costUsd: string | null;
  priceVersion: string | null;
}

export interface StepRunCostData {
  totalCostUsd: string | null;
  attempts: AttemptCostData[];
}

export interface RunCostData {
  totalCostUsd: string | null;
  supportedAttempts: number;
  unsupportedAttempts: number;
  credentialPrincipalId: string;
  /** False while the Run is still in flight — the total is then the *running* cost. */
  runEnded: boolean;
}

export interface ProjectCostPrincipalData {
  credentialPrincipalId: string;
  costUsd: string;
}

export interface ProjectCostData {
  totalCostUsd: string | null;
  /** Always true — the total is a lower bound, never the full spend. */
  lowerBound: true;
  byCredentialPrincipal: ProjectCostPrincipalData[];
}
