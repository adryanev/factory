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
import * as runsDomain from "./runs.js";
import * as runnersDomain from "./runners.js";
import * as claimDomain from "./step-run-claim.js";
import * as turnDomain from "./step-run-turn.js";
import * as stepRunOpsDomain from "./step-run-ops.js";
import * as secretsDomain from "./secrets.js";
import * as egressDomain from "./egress.js";
import type { Principal } from "./principal.js";
import type { LoginResult } from "./auth.js";
import type { Project, ProjectRole } from "./projects.js";
import type { Group } from "./groups.js";
import type { RunListFilters, RunPage, RunWithGraph, TriggerRunInput, TriggeredRun } from "./runs.js";
import type { DesiredState, HeartbeatLease, HeartbeatReply, RunnerIdentity } from "./runners.js";
import type { ClaimedStepRun, ClaimInput } from "./step-run-claim.js";
import type { LogChunkInput, QuestionInput, ResultInput, ResultRecord, UploadGrant, UploadRequest } from "./step-run-turn.js";
import type { ServiceAccountInfo, StoredSecret, PutSecretInput } from "./secrets.js";

export type { Principal } from "./principal.js";
export type { Project, ProjectRole } from "./projects.js";
export type { Group } from "./groups.js";
export type { Run, StepRun, RunListFilters, RunPage, RunWithGraph, TriggerRunInput, TriggeredRun } from "./runs.js";
export {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  DomainValidationError,
  ProtocolVersionError,
  LeaseConflictError,
} from "./errors.js";
export { ClaimCapacityError } from "./step-run-claim.js";
export type { LoginResult } from "./auth.js";
export type { DesiredState, HeartbeatLease, HeartbeatReply, RunnerIdentity } from "./runners.js";
export type { ClaimedStepRun, ClaimInput } from "./step-run-claim.js";
export type {
  LogChunkInput,
  QuestionInput,
  ResultInput,
  ResultRecord,
  UploadGrant,
  UploadRequest,
} from "./step-run-turn.js";
export type { ServiceAccountInfo, StoredSecret, PutSecretInput } from "./secrets.js";

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
    updateSettings: (
      principal: Principal,
      projectId: Id<"project">,
      patch: { allowSharedAgentCredential?: boolean },
    ) => Promise<Project>;
  };
  groups: {
    create: (principal: Principal, projectId: Id<"project">, name: string) => Promise<Group>;
    addMember: (principal: Principal, groupId: Id<"group">, targetPrincipalId: Id<"user">) => Promise<void>;
  };
  runs: {
    trigger: (principal: Principal, projectId: Id<"project">, input: TriggerRunInput) => Promise<TriggeredRun>;
    list: (
      principal: Principal,
      projectId: Id<"project">,
      filters: RunListFilters,
      cursor: Id<"run"> | null,
      limit: number,
    ) => Promise<RunPage>;
    get: (principal: Principal, projectId: Id<"project">, runId: Id<"run">) => Promise<RunWithGraph>;
  };
  runners: {
    /** Bearer secret -> `RunnerIdentity`. Throws `UnauthorizedError` for a missing/malformed header, a wrong secret, or a revoked one — see `runners.ts`'s doc on why revoke is fencing, enforced right here. */
    authenticate: (bearerAuthorizationHeader: string | undefined) => Promise<RunnerIdentity>;
    join: (token: string) => Promise<{ runnerId: Id<"runner">; secret: string }>;
    reportCapabilities: (
      runner: RunnerIdentity,
      capsHash: string,
      capabilities: unknown,
      releaseVersion: string | undefined,
    ) => Promise<void>;
    selfDrain: (runner: RunnerIdentity) => Promise<void>;
    heartbeat: (
      runner: RunnerIdentity,
      input: { leases: HeartbeatLease[]; capsHash: string | null; protocolVersion: number | null },
    ) => Promise<HeartbeatReply>;
    /** Operator surface, org `owner` only. */
    mintJoinToken: (principal: Principal) => Promise<{ token: string }>;
    setPolicy: (principal: Principal, runnerId: Id<"runner">, policy: { slots: number; tags: string[] }) => Promise<void>;
    drain: (principal: Principal, runnerId: Id<"runner">) => Promise<void>;
    revoke: (principal: Principal, runnerId: Id<"runner">) => Promise<void>;
  };
  stepRuns: {
    claim: (runner: RunnerIdentity, input: ClaimInput) => Promise<ClaimedStepRun | null>;
    mintUploadGrants: (
      runner: RunnerIdentity,
      stepRunId: Id<"steprun">,
      leaseToken: string,
      requests: UploadRequest[],
    ) => Promise<UploadGrant[]>;
    recordLogChunks: (
      runner: RunnerIdentity,
      stepRunId: Id<"steprun">,
      leaseToken: string,
      chunks: LogChunkInput[],
    ) => Promise<void>;
    submitQuestion: (
      runner: RunnerIdentity,
      stepRunId: Id<"steprun">,
      leaseToken: string,
      input: QuestionInput,
    ) => Promise<{ questionId: Id<"question"> }>;
    submitResult: (
      runner: RunnerIdentity,
      stepRunId: Id<"steprun">,
      leaseToken: string,
      input: ResultInput,
    ) => Promise<ResultRecord>;
    /** Operator surface, Project `member`. */
    cancel: (principal: Principal, stepRunId: Id<"steprun">) => Promise<void>;
  };
  secrets: {
    createServiceAccount: (
      principal: Principal,
      projectId: Id<"project">,
      name: string,
    ) => Promise<ServiceAccountInfo>;
    listServiceAccounts: (principal: Principal, projectId: Id<"project">) => Promise<ServiceAccountInfo[]>;
    store: (principal: Principal, projectId: Id<"project">, input: PutSecretInput) => Promise<StoredSecret>;
    update: (
      principal: Principal,
      projectId: Id<"project">,
      secretId: Id<"secret">,
      value: string,
    ) => Promise<StoredSecret>;
    remove: (principal: Principal, projectId: Id<"project">, secretId: Id<"secret">) => Promise<void>;
    list: (principal: Principal, projectId: Id<"project">) => Promise<StoredSecret[]>;
    rotate: (principal: Principal, projectId: Id<"project">) => Promise<{ rotated: number; toVersion: number }>;
  };
  egress: {
    setAllowlist: (principal: Principal, projectId: Id<"project">, allowlist: string[]) => Promise<string[]>;
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
      updateSettings: (principal, projectId, patch) =>
        projectsDomain.updateProjectSettings(deps, principal, projectId, patch),
    },
    groups: {
      create: (principal, projectId, name) => groupsDomain.createGroup(deps, principal, projectId, name),
      addMember: (principal, groupId, targetPrincipalId) =>
        groupsDomain.addGroupMember(deps, principal, groupId, targetPrincipalId),
    },
    runs: {
      trigger: (principal, projectId, input) => runsDomain.triggerRun(deps, principal, projectId, input),
      list: (principal, projectId, filters, cursor, limit) =>
        runsDomain.listRuns(deps, principal, projectId, filters, cursor, limit),
      get: (principal, projectId, runId) => runsDomain.getRun(deps, principal, projectId, runId),
    },
    runners: {
      authenticate: (bearerAuthorizationHeader) =>
        runnersDomain.authenticateRunner(deps, runnersDomain.parseBearerSecret(bearerAuthorizationHeader)),
      join: (token) => runnersDomain.joinRunner(deps, token),
      reportCapabilities: (runner, capsHash, capabilities, releaseVersion) =>
        runnersDomain.reportCapabilities(deps, runner, capsHash, capabilities, releaseVersion),
      selfDrain: (runner) => runnersDomain.selfDrain(deps, runner),
      heartbeat: (runner, input) => runnersDomain.heartbeat(deps, runner, input),
      mintJoinToken: (principal) => runnersDomain.mintJoinToken(deps, principal),
      setPolicy: (principal, runnerId, policy) => runnersDomain.setRunnerPolicy(deps, principal, runnerId, policy),
      drain: (principal, runnerId) => runnersDomain.drainRunner(deps, principal, runnerId),
      revoke: (principal, runnerId) => runnersDomain.revokeRunner(deps, principal, runnerId),
    },
    stepRuns: {
      claim: (runner, input) => claimDomain.claimStepRun(deps, runner, input),
      mintUploadGrants: (runner, stepRunId, leaseToken, requests) =>
        turnDomain.mintUploadGrants(deps, runner, stepRunId, leaseToken, requests),
      recordLogChunks: (runner, stepRunId, leaseToken, chunks) =>
        turnDomain.recordLogChunks(deps, runner, stepRunId, leaseToken, chunks),
      submitQuestion: (runner, stepRunId, leaseToken, input) =>
        turnDomain.submitQuestion(deps, runner, stepRunId, leaseToken, input),
      submitResult: (runner, stepRunId, leaseToken, input) =>
        turnDomain.submitResult(deps, runner, stepRunId, leaseToken, input),
      cancel: (principal, stepRunId) => stepRunOpsDomain.cancelStepRun(deps, principal, stepRunId),
    },
    secrets: {
      createServiceAccount: (principal, projectId, name) =>
        secretsDomain.createServiceAccount(deps, principal, projectId, name),
      listServiceAccounts: (principal, projectId) =>
        secretsDomain.listServiceAccounts(deps, principal, projectId),
      store: (principal, projectId, input) => secretsDomain.storeSecret(deps, principal, projectId, input),
      update: (principal, projectId, secretId, value) =>
        secretsDomain.updateSecretValue(deps, principal, projectId, secretId, value),
      remove: (principal, projectId, secretId) =>
        secretsDomain.deleteSecret(deps, principal, projectId, secretId),
      list: (principal, projectId) => secretsDomain.listSecrets(deps, principal, projectId),
      rotate: (principal, projectId) => secretsDomain.rotateProjectSecrets(deps, principal, projectId),
    },
    egress: {
      setAllowlist: (principal, projectId, allowlist) =>
        egressDomain.setProjectEgressAllowlist(deps, principal, projectId as never, allowlist),
    },
  };
}

/** What a route handler actually receives. No `db`, no `random` — a route has no legitimate use for either directly. */
export interface RouteDeps {
  domain: Domain;
  clock: Clock;
}
