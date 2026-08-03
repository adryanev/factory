/**
 * The three ways a domain function refuses a caller, mapped to HTTP status
 * by `app.ts`'s `onError` — never decided in the route handler itself. Every
 * domain function that reads or writes a Principal-guarded table throws one
 * of these instead of returning a sentinel, so a route can't forget to check
 * the result before proceeding (spec: "Kontrak API web <-> control plane" —
 * "401 belum login, 403 login tapi tidak boleh dengan badan menyebut project
 * dan sebabnya, 404 benar-benar tidak ada").
 */

/** Not authenticated at all. Ambient (session cookie missing/invalid) — this is the one place "who are you" is allowed to be ambient. */
export class UnauthorizedError extends Error {
  constructor(message = "not logged in") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Authenticated, but not permitted. `message` always names the resource and
 * the reason — it is the entire 403 body's `message` field, since
 * `errorResponseSchema` carries nothing but `{ code, message }` (see
 * `@factory/shared` errors.ts: "Nothing else goes in this envelope").
 */
export class ForbiddenError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ForbiddenError";
    this.code = code;
  }
}

/** Genuinely does not exist. Checked only after authentication — see each domain function for why 403 is checked first where both could apply. */
export class NotFoundError extends Error {
  constructor(resourceType: string, id: string) {
    super(`no ${resourceType} with id ${id}`);
    this.name = "NotFoundError";
  }
}

/**
 * A business-rule rejection that is not about who's asking — e.g. a Group
 * member who isn't a member of the Group's Project. 400, not 403: the actor
 * was allowed to attempt the write, the write's content is what's invalid.
 */
export class DomainValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainValidationError";
    this.code = code;
  }
}
