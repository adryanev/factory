/**
 * Identifies a request path as belonging to the Runner protocol (bearer
 * secret, never a browser) rather than the web <-> control-plane surface
 * (session cookie, CSRF-relevant). `app.ts` uses this to exempt exactly
 * these paths from the CSRF header requirement and apply the 1 MiB body-size
 * cap — a Runner is an ordinary non-browser HTTP client with no ambient
 * cookie a foreign origin could ride, so the CSRF defense has nothing to
 * defend here (see `csrf.ts`'s doc on why the check exists at all).
 *
 * Deliberately a fixed literal set, not a prefix match on `/step-runs/` —
 * `/step-runs/{id}/cancel` (operator/UI, session-authenticated,
 * `runner-admin.ts`) sits right next to `/step-runs/{id}/result` (Runner-
 * authenticated) under the same resource, and only the suffix tells them
 * apart.
 */
const EXACT_PATHS = new Set(["/join", "/claim", "/heartbeat", "/runners/me/capabilities", "/runners/me/drain"]);

const STEP_RUN_SUFFIX_PATTERN = /^\/step-runs\/[^/]+\/(uploads|log-chunks|question|result)$/;

export function isRunnerProtocolPath(path: string): boolean {
  return EXACT_PATHS.has(path) || STEP_RUN_SUFFIX_PATTERN.test(path);
}
