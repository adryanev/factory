import type { Context } from "hono";
import type { AppEnv } from "../http-env.js";
import { UnauthorizedError } from "../domain/errors.js";
import type { Principal } from "../domain/index.js";

/** Every route that needs a caller identity reads it through here — never `c.get("principal")` directly, so a missing session always becomes a 401 and never an accidental `undefined` passed into a domain function. */
export function requirePrincipal(c: Context<AppEnv>): Principal {
  const principal = c.get("principal");
  if (!principal) {
    throw new UnauthorizedError();
  }
  return principal;
}
