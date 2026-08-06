/**
 * Login is the one place "who are you" is decided — everything downstream
 * (roles, Project membership, Group membership) reads it back out of the
 * `Principal` these functions hand back, never out of GitHub or the
 * break-glass password again (spec: "Ambient boleh untuk otentikasi, tidak
 * pernah untuk otorisasi"). GitHub OAuth and break-glass are two front
 * doors to **the same session mechanism** — both end in
 * `createSessionForPrincipal`, so the cookie either produces is
 * byte-for-byte the same shape. Only the audit action differs.
 */
import { eq, isNotNull } from "drizzle-orm";
import { generateId, type Id } from "@factory/shared";
import { principals, sessions, users, orgMembers } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { GithubOAuthClient } from "./github-identity.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateSessionToken, hashSessionToken } from "./session-token.js";
import type { Principal } from "./principal.js";
import { recordAuditEvent } from "./audit.js";
import { UnauthorizedError } from "./errors.js";

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — not spec'd; a reasonable default for an internal tool.

export interface LoginResult {
  principal: Principal;
  /** Raw bearer token for the cookie. Never stored — only `hashSessionToken(sessionToken)` is written to Postgres. */
  sessionToken: string;
  expiresAt: Date;
}

async function createSessionForPrincipal(
  deps: Pick<AppDeps, "db" | "clock" | "random">,
  principalId: Id<"user">,
): Promise<{ sessionToken: string; expiresAt: Date }> {
  const sessionToken = generateSessionToken((length) => deps.random.bytes(length));
  const expiresAt = new Date(deps.clock.now().getTime() + SESSION_LIFETIME_MS);
  await deps.db.insert(sessions).values({
    id: generateId("session"),
    principalId,
    tokenHash: hashSessionToken(sessionToken),
    expiresAt,
  });
  return { sessionToken, expiresAt };
}

/**
 * GitHub identity is matched on `github_user_id` (immutable), not login
 * (renameable). First-ever sight of a `githubUserId` creates a dormant
 * `principals`/`users` row with zero org or Project membership — logging in
 * authenticates; it never grants access on its own. An existing org owner
 * has to add the new user to `org_members` and/or `project_members`
 * afterward (out of this issue's endpoint surface — see the written report
 * for why).
 */
export async function loginWithGithub(
  deps: Pick<AppDeps, "db" | "clock" | "random">,
  githubOAuth: GithubOAuthClient,
  code: string,
  redirectUri: string,
): Promise<LoginResult> {
  const identity = await githubOAuth.exchangeCode(code, redirectUri);

  const [existing] = await deps.db
    .select()
    .from(users)
    .where(eq(users.githubUserId, identity.githubUserId));

  let principalId: Id<"user">;
  if (existing) {
    principalId = existing.principalId;
    await deps.db
      .update(users)
      .set({
        githubLogin: identity.githubLogin,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
      })
      .where(eq(users.principalId, principalId));
  } else {
    principalId = generateId("user");
    await deps.db.insert(principals).values({ id: principalId, kind: "user" });
    await deps.db.insert(users).values({
      principalId,
      githubUserId: identity.githubUserId,
      githubLogin: identity.githubLogin,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    });
  }

  const principal: Principal = { id: principalId, kind: "user" };
  const { sessionToken, expiresAt } = await createSessionForPrincipal(deps, principalId);

  await recordAuditEvent(deps, {
    actor: principal,
    action: "auth.login_github",
    targetType: "user",
    targetId: principalId,
    metadata: { githubLogin: identity.githubLogin },
  });

  return { principal, sessionToken, expiresAt };
}

/**
 * The single break-glass row is identified structurally by
 * `password_hash IS NOT NULL` — GitHub-authenticated users never have one
 * (see `db/schema/principals.ts`). `bootstrapBreakGlassAccount` is called
 * once at process boot (`main.ts`) and by every seam-1 test's setup; it is
 * idempotent so re-running it (e.g. a config'd password rotation) updates
 * the existing row instead of creating a second one.
 */
export async function bootstrapBreakGlassAccount(
  deps: Pick<AppDeps, "db">,
  password: string,
): Promise<Id<"user">> {
  const passwordHash = await hashPassword(password);

  const [existing] = await deps.db.select().from(users).where(isNotNull(users.passwordHash));

  if (existing) {
    await deps.db.update(users).set({ passwordHash }).where(eq(users.principalId, existing.principalId));
    return existing.principalId;
  }

  const principalId = generateId("user");
  await deps.db.insert(principals).values({ id: principalId, kind: "user" });
  await deps.db.insert(users).values({ principalId, passwordHash, name: "Break-glass" });
  // The break-glass account is the one principal guaranteed to exist before
  // anyone has logged in through GitHub, so it is also the org's first
  // `owner` — otherwise no one could ever grant that role to anyone else.
  await deps.db.insert(orgMembers).values({ principalId, role: "owner" }).onConflictDoNothing();
  return principalId;
}

export async function loginBreakGlass(
  deps: Pick<AppDeps, "db" | "clock" | "random">,
  password: string,
): Promise<LoginResult> {
  const [account] = await deps.db.select().from(users).where(isNotNull(users.passwordHash));
  if (!account?.passwordHash || !(await verifyPassword(password, account.passwordHash))) {
    throw new UnauthorizedError("invalid break-glass credentials");
  }

  const principal: Principal = { id: account.principalId, kind: "user" };
  const { sessionToken, expiresAt } = await createSessionForPrincipal(deps, account.principalId);

  await recordAuditEvent(deps, {
    actor: principal,
    action: "auth.login_breakglass",
    targetType: "user",
    targetId: account.principalId,
  });

  return { principal, sessionToken, expiresAt };
}

/** Ambient by design — this is the one function allowed to turn a raw cookie value into a `Principal`, for every other function to take as an explicit argument. */
export async function resolveSession(
  deps: Pick<AppDeps, "db" | "clock">,
  sessionToken: string,
): Promise<Principal | null> {
  const [row] = await deps.db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hashSessionToken(sessionToken)));

  if (!row || row.expiresAt.getTime() <= deps.clock.now().getTime()) {
    return null;
  }
  return { id: row.principalId, kind: "user" };
}

export async function logout(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  sessionToken: string,
): Promise<void> {
  await deps.db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(sessionToken)));
  await recordAuditEvent(deps, { actor: principal, action: "auth.logout" });
}
