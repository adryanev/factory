/**
 * Binds every domain function to the process's `AppDeps` once, at the
 * composition root, and hands routes back a `Domain` object instead of
 * `AppDeps` itself. This is the actual enforcement mechanism for "tables
 * are reachable only through domain functions that take a `Principal`":
 * `RouteDeps` below has no `db` field. A route file cannot write
 * `deps.db.select().from(projects)` because there is no `deps.db` in its
 * scope to write — the compiler rejects it, not a linter or a reviewer.
 * (Compare `db/client.ts`'s `Database` type, which is still passed whole to
 * `registerHealthRoutes`/`registerScaffoldProbeRoutes` — those two are the
 * pre-existing, explicitly non-domain, unguarded scaffold routes from issue
 * #2, and are the only ones that keep raw `db` access.)
 */
import type { Id } from "@factory/shared";
import type { AppDeps, Clock } from "../deps.js";
import * as authDomain from "./auth.js";
import * as projectsDomain from "./projects.js";
import * as groupsDomain from "./groups.js";
import type { Principal } from "./principal.js";
import type { LoginResult } from "./auth.js";
import type { Project, ProjectRole } from "./projects.js";
import type { Group } from "./groups.js";

export type { Principal } from "./principal.js";
export type { Project, ProjectRole } from "./projects.js";
export type { Group } from "./groups.js";
export { UnauthorizedError, ForbiddenError, NotFoundError, DomainValidationError } from "./errors.js";
export type { LoginResult } from "./auth.js";

export interface Domain {
  auth: {
    /** Not Principal-guarded — building the redirect URL reveals nothing and starts an OAuth handshake, not a login. */
    githubAuthorizeUrl: (state: string, redirectUri: string) => string;
    loginWithGithub: (code: string, redirectUri: string) => Promise<LoginResult>;
    loginBreakGlass: (password: string) => Promise<LoginResult>;
    resolveSession: (sessionToken: string) => Promise<Principal | null>;
    logout: (principal: Principal, sessionToken: string) => Promise<void>;
  };
  projects: {
    listMine: (principal: Principal) => Promise<Project[]>;
    create: (principal: Principal, name: string) => Promise<Project>;
    get: (principal: Principal, projectId: Id<"project">) => Promise<Project>;
    addMember: (
      principal: Principal,
      projectId: Id<"project">,
      targetPrincipalId: Id<"user">,
      role: ProjectRole,
    ) => Promise<void>;
    selfAddAsMember: (principal: Principal, projectId: Id<"project">) => Promise<void>;
  };
  groups: {
    create: (principal: Principal, projectId: Id<"project">, name: string) => Promise<Group>;
    addMember: (principal: Principal, groupId: Id<"group">, targetPrincipalId: Id<"user">) => Promise<void>;
  };
}

export function createDomain(deps: AppDeps): Domain {
  return {
    auth: {
      githubAuthorizeUrl: (state, redirectUri) => deps.githubOAuth.authorizeUrl(state, redirectUri),
      loginWithGithub: (code, redirectUri) =>
        authDomain.loginWithGithub(deps, deps.githubOAuth, code, redirectUri),
      loginBreakGlass: (password) => authDomain.loginBreakGlass(deps, password),
      resolveSession: (sessionToken) => authDomain.resolveSession(deps, sessionToken),
      logout: (principal, sessionToken) => authDomain.logout(deps, principal, sessionToken),
    },
    projects: {
      listMine: (principal) => projectsDomain.listProjectsForPrincipal(deps, principal),
      create: (principal, name) => projectsDomain.createProject(deps, principal, name),
      get: (principal, projectId) => projectsDomain.getProjectForPrincipal(deps, principal, projectId),
      addMember: (principal, projectId, targetPrincipalId, role) =>
        projectsDomain.addProjectMember(deps, principal, projectId, targetPrincipalId, role),
      selfAddAsMember: (principal, projectId) =>
        projectsDomain.selfAddAsProjectMember(deps, principal, projectId),
    },
    groups: {
      create: (principal, projectId, name) => groupsDomain.createGroup(deps, principal, projectId, name),
      addMember: (principal, groupId, targetPrincipalId) =>
        groupsDomain.addGroupMember(deps, principal, groupId, targetPrincipalId),
    },
  };
}

/** What a route handler actually receives. No `db`, no `random` — a route has no legitimate use for either directly. */
export interface RouteDeps {
  domain: Domain;
  clock: Clock;
}
