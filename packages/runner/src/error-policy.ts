/**
 * The Runner's entire reaction table to an HTTP response, extracted as a
 * pure function so it is testable without a server. Spec's error table,
 * "hanya satu yang mematikan":
 *
 * | Status        | Meaning                          | Runner does        |
 * |---------------|-----------------------------------|---------------------|
 * | 401           | secret wrong or revoked           | **stop**            |
 * | 426           | protocol out of range             | slow-poll, keep going |
 * | 409           | lease no longer yours / ended     | drop it, back to /claim |
 * | 400, 422      | payload rejected                  | fatal to the turn, not the Runner |
 * | 413           | over a size limit                 | fatal to that request only |
 * | 429, 503      | overloaded / restarting           | backoff, honor Retry-After |
 * | other 5xx, timeout | unknown                     | backoff, retry      |
 *
 * `decideOnStatus` collapses all of this to the one bit that actually
 * changes the Runner's top-level control flow: does it stop, or does it
 * keep heartbeating and returning to `/claim`? Everything else (which
 * specific backoff, whether a turn's own outcome is affected) is a detail
 * inside "keep going", not a second axis this function needs to expose —
 * the *acceptance criterion* is exactly this one bit.
 */

export type RunnerAction = "stop" | "continue";

export function decideOnStatus(status: number): RunnerAction {
  return status === 401 ? "stop" : "continue";
}
