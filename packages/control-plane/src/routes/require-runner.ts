import type { Context } from "hono";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import type { RunnerIdentity } from "../domain/index.js";

/**
 * The Runner-surface analogue of `require-principal.ts`'s `requirePrincipal`
 * — every one of the nine Runner-protocol routes (except `/join`, which has
 * no identity yet) reads its caller through here, never by hand-parsing the
 * header itself, so the "wrong/missing/revoked secret is 401" rule lives in
 * exactly one place (`domain/runners.ts`'s `authenticateRunner`).
 */
export async function requireRunner(c: Context<AppEnv>, deps: RouteDeps): Promise<RunnerIdentity> {
  return deps.domain.runners.authenticate(c.req.header("authorization"));
}
