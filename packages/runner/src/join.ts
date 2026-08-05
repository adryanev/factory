/**
 * The join-token exchange, gated by isolation verification (spec
 * "Packaging self-host", decision 6 + 8; issue #10's isolation line).
 *
 * Order is load-bearing and tested:
 *
 *   1. `verifyIsolation` — the agent user must not be able to read the
 *      identity file (see `isolation.ts`).
 *   2. POST /join — exchange the one-time join token for { runner_id,
 *      secret }.
 *   3. `writeIdentity` — persist the credential to disk (mode 0600).
 *
 * A machine that fails step 1 never reaches step 2: it never has an
 * identity, so it never appears in the pool and can never be handed work.
 * That is the structural guarantee behind "instalasi separuh jadi tidak
 * pernah menghasilkan mesin yang diam-diam tidak terlindungi" — the gate
 * lives in the runner binary, not in the installer script, so re-running
 * join by hand on a misconfigured machine gets the same refusal.
 */
import { writeIdentity } from "./identity.js";
import type { IsolationProbe } from "./isolation.js";
import { verifyIsolation } from "./isolation.js";

export interface JoinExchange {
  runnerId: string;
  secret: string;
}

export class JoinTokenRejectedError extends Error {
  override readonly name = "JoinTokenRejectedError";
}

/**
 * Exchanges the one-time join token for runner credentials over HTTP
 * (`POST {baseUrl}/join`, wire shape `{ runner_id, secret }` — the
 * Runner-protocol contract's own `snake_case`).
 */
export async function exchangeJoinToken(baseUrl: string, token: string): Promise<JoinExchange> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (response.status === 401) {
    throw new JoinTokenRejectedError("join token rejected: invalid, unknown, or already used");
  }
  if (!response.ok) {
    throw new Error(`join failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { runner_id?: string; secret?: string };
  if (typeof body.runner_id !== "string" || typeof body.secret !== "string") {
    throw new Error("join response did not carry a runner id and secret");
  }
  return { runnerId: body.runner_id, secret: body.secret };
}

export interface JoinInput {
  baseUrl: string;
  token: string;
  identityFilePath: string;
  probe: IsolationProbe;
  exchange?: (baseUrl: string, token: string) => Promise<JoinExchange>;
}

/** The full gated join: verify isolation, exchange the token, persist identity. */
export async function joinRunner(input: JoinInput): Promise<JoinExchange> {
  await verifyIsolation(input.identityFilePath, input.probe);
  const exchange = input.exchange ?? exchangeJoinToken;
  const identity = await exchange(input.baseUrl, input.token);
  await writeIdentity(input.identityFilePath, identity);
  return identity;
}
