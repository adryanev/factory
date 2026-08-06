import type { Principal } from "./domain/principal.js";

/**
 * Hono's `Env` type parameter for this app. Split into its own file so both
 * `app.ts` (which sets `principal`) and every route file (which reads it)
 * can import it without a circular dependency on `app.ts` itself.
 */
export interface AppEnv {
  Variables: {
    /** Set once per request by `app.ts`'s session middleware — the one ambient read of "who are you" (spec: "Ambient boleh untuk otentikasi"). `null` when there is no valid session; routes decide whether that's fatal. */
    principal: Principal | null;
  };
}
