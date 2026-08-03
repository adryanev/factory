import type { Id } from "@factory/shared";

/**
 * Identity that can trigger a Run and holds credentials — a User or a
 * ServiceAccount (CONTEXT.md). This is the type every domain function in
 * `src/domain/**` takes as its first argument. It is never read from
 * ambient context inside a domain function — see `domain/index.ts` for how
 * transport resolves one from the session cookie and threads it through.
 */
/**
 * A discriminated union, not `{ id: Id<"user"> | Id<"serviceaccount">, kind }`
 * — narrowing on `kind` needs to narrow `id`'s type too (org/project
 * membership is structurally User-only; a `principal.kind === "user"` check
 * should make `principal.id` an `Id<"user">` to the compiler, not require a
 * cast).
 */
export type Principal = { kind: "user"; id: Id<"user"> } | { kind: "service_account"; id: Id<"serviceaccount"> };
