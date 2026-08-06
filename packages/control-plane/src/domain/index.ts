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
import * as automationDomain from "./automation.js";
import * as egressDomain from "./egress.js";
import type { Principal } from "./principal.js";
import type { LoginResult } from "./auth.js";
import type { Project, ProjectRole } from "./projects.js";
import type { Group } from "./groups.js";
import type {
  GrillingSummary,
  Run,
  RunListFilters,
  RunPage,
  RunWithGraph,
  RewindRunInput,
  TriggerRunInput,
  TriggeredRun,
} from "./runs.js";
import type { DesiredState, HeartbeatLease, HeartbeatReply, RunnerIdentity } from "./runners.js";
import type { ClaimedStepRun, ClaimInput } from "./step-run-claim.js";
import * as stepRunLogsDomain from "./step-run-logs.js";
import * as stepRunArtifactsDomain from "./step-run-artifacts.js";
import * as costsDomain from "./costs.js";
import * as stepRunQuestionsDomain from "./step-run-questions.js";
import * as pipelineEditorDomain from "./pipeline-editor.js";
import type {
  AnswerQuestionResult,
  ArtifactEditUpload,
  QuestionState,
} from "./step-run-questions.js";
import type {
  ArtifactMetadataInput,
  LogChunkInput,
  QuestionInput,
  ResultInput,
  ResultRecord,
  UploadGrant,
  UploadRequest,
} from "./step-run-turn.js";
import type { ArtifactHistoryMeta, ArtifactMeta, ArtifactRead } from "./step-run-artifacts.js";
import type { AttemptCost, ProjectCost, ProjectCostPrincipal, RunCost, StepRunCost } from "./costs.js";
import type { ServiceAccountInfo, StoredSecret, PutSecretInput } from "./secrets.js";
import type { EditorPullRequestResult, EditorRepository, OpenEditorPullRequestInput } from "./pipeline-editor.js";

export type { Principal } from "./principal.js";
export type { Project, ProjectRole } from "./projects.js";
export type { Group } from "./groups.js";
export type {
  GrillingSummary,
  RewindRunInput,
  Run,
  StepRun,
  RunListFilters,
  RunPage,
  RunWithGraph,
  TriggerRunInput,
  TriggeredRun,
} from "./runs.js";
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
  ArtifactMetadataInput,
  LogChunkInput,
  QuestionInput,
  ResultInput,
  ResultRecord,
  UploadGrant,
  UploadRequest,
} from "./step-run-turn.js";
export type { ArtifactHistoryMeta, ArtifactMeta, ArtifactRead } from "./step-run-artifacts.js";
export type { AttemptCost, ProjectCost, ProjectCostPrincipal, RunCost, StepRunCost } from "./costs.js";
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
      patch: { allowSharedAgentCredential?: boolean; notificationWebhookUrl?: string | null },
    ) => Promise<Project>;
  };
  groups: {
    create: (principal: Principal, projectId: Id<"project">, name: string) => Promise<Group>;
    addMember: (principal: Principal, groupId: Id<"group">, targetPrincipalId: Id<"user">) => Promise<void>;
  };
  runs: {
    trigger: (principal: Principal, projectId: Id<"project">, input: TriggerRunInput) => Promise<TriggeredRun>;
    cancel: (principal: Principal, projectId: Id<"project">, runId: Id<"run">) => Promise<Run>;
    cancelById: (principal: Principal, runId: Id<"run">) => Promise<Run>;
    rewind: (principal: Principal, projectId: Id<"project">, input: RewindRunInput) => Promise<TriggeredRun>;
    rewindById: (principal: Principal, input: RewindRunInput) => Promise<TriggeredRun>;
    list: (
      principal: Principal,
      projectId: Id<"project">,
      filters: RunListFilters,
      cursor: Id<"run"> | null,
      limit: number,
    ) => Promise<RunPage>;
    get: (principal: Principal, projectId: Id<"project">, runId: Id<"run">) => Promise<RunWithGraph>;
    summary: (
      principal: Principal,
      projectId: Id<"project">,
      runId: Id<"run">,
    ) => Promise<GrillingSummary>;
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
    /** Web surface, Project `member`: live-tail from any offset — archive is the same call with offset 0. Returns presigned GETs, never bytes. */
    readLogChunks: (
      principal: Principal,
      stepRunId: Id<"steprun">,
      input: { attempt?: number; offset: number },
    ) => Promise<stepRunLogsDomain.LogTailResult>;
    /** Web surface, Project `member`: one StepRun's artifacts, metadata only. */
    listArtifacts: (
      principal: Principal,
      stepRunId: Id<"steprun">,
      key?: string,
    ) => Promise<ArtifactMeta[]>;
    /** Web surface, Project `member`: one artifact plus a freshly-minted presigned GET. */
    getArtifact: (principal: Principal, artifactId: Id<"artifact">) => Promise<ArtifactRead>;
    /** Web surface, Project `member`: immutable artifact history for one Run. */
    listRunArtifacts: (
      principal: Principal,
      projectId: Id<"project">,
      runId: Id<"run">,
      key?: string,
    ) => Promise<ArtifactHistoryMeta[]>;
  };
  questions: {
    /** Web surface, group member: the "Menunggu saya" list — every open Question whose audience Group contains the caller. */
    listWaiting: (principal: Principal) => Promise<QuestionState[]>;
    /** Web surface badge count. This is a query over open Questions, never a maintained counter. */
    countWaiting: (principal: Principal) => Promise<number>;
    /** Web surface, group member: one Question's latest state. */
    get: (principal: Principal, questionId: Id<"question">) => Promise<QuestionState>;
    /** Web surface, group member: record an answer, compare-and-set. `race-lost` is the ordinary outcome of losing the race (AC8), not an exception. */
    answer: (
      principal: Principal,
      questionId: Id<"question">,
      answer: import("@factory/shared").Answer,
    ) => Promise<AnswerQuestionResult>;
    mintArtifactEditUpload: (
      principal: Principal,
      questionId: Id<"question">,
      sizeBytes: number,
    ) => Promise<ArtifactEditUpload>;
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
  automation: {
    /**
     * The `/webhook/github` surface: verify the HMAC, drop the raw event
     * (layer-1 dedup), answer. All mapping happens on the sweep — see
     * `domain/automation.ts`.
     */
    ingestWebhook: (
      input: automationDomain.WebhookIngestInput,
    ) => Promise<automationDomain.WebhookIngestResult>;
    /**
     * The sweep — webhook deliveries → triggers, the concurrency-queue drain,
     * and the schedule evaluation. Wired into `sweepExpiredLeases` so it
     * rides boot + the executor cadence; tests call it directly.
     */
    sweep: () => Promise<{ deliveries: number; drained: number }>;
    /** The "cron yang dilewati" list — Project `member`, keyset on id DESC. */
    listCronSkips: (
      principal: Principal,
      projectId: Id<"project">,
      cursor: string | null,
      limit: number,
    ) => Promise<automationDomain.CronSkipPage>;
  };
  egress: {
    setAllowlist: (principal: Principal, projectId: Id<"project">, allowlist: string[]) => Promise<string[]>;
  };
  costs: {
    /** Web surface, Project `member`: one StepRun's cost with the per-attempt breakdown (issue 12, AC6). */
    stepRun: (principal: Principal, stepRunId: Id<"steprun">) => Promise<StepRunCost>;
    /** Web surface, Project `member`: one Run's cost — while in flight this is the running cost (AC8). */
    run: (principal: Principal, projectId: Id<"project">, runId: Id<"run">) => Promise<RunCost>;
    /** Web surface, Project `member`: the Project's cost, explicitly a lower bound, by credential principal (AC2/AC9). */
    project: (principal: Principal, projectId: Id<"project">) => Promise<ProjectCost>;
  };
  editor: {
    /** Web surface, Project `member` (issue #20, AC1): the host-repo candidates the editor UI may lock onto — this Project's repositories, nothing else. */
    listRepositories: (principal: Principal, projectId: Id<"project">) => Promise<EditorRepository[]>;
    /** Web surface, Project `member` (issue #20, AC7): validates the definition with the shared Zod schema and opens a PR with the YAML in the host repo. Not an audit event (AC8) — the PR is itself the permanent attributed record. */
    openPullRequest: (
      principal: Principal,
      projectId: Id<"project">,
      input: OpenEditorPullRequestInput,
    ) => Promise<EditorPullRequestResult>;
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
      cancel: (principal, projectId, runId) => runsDomain.cancelRun(deps, principal, projectId, runId),
      cancelById: (principal, runId) => runsDomain.cancelRunById(deps, principal, runId),
      rewind: (principal, projectId, input) => runsDomain.rewindRun(deps, principal, projectId, input),
      rewindById: (principal, input) => runsDomain.rewindRunById(deps, principal, input),
      list: (principal, projectId, filters, cursor, limit) =>
        runsDomain.listRuns(deps, principal, projectId, filters, cursor, limit),
      get: (principal, projectId, runId) => runsDomain.getRun(deps, principal, projectId, runId),
      summary: (principal, projectId, runId) =>
        runsDomain.getGrillingSummary(deps, principal, projectId, runId),
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
      readLogChunks: (principal, stepRunId, input) =>
        stepRunLogsDomain.readLogChunks(deps, principal, stepRunId, input),
      listArtifacts: (principal, stepRunId, key) =>
        stepRunArtifactsDomain.listStepRunArtifacts(deps, principal, stepRunId, key),
      getArtifact: (principal, artifactId) =>
        stepRunArtifactsDomain.getArtifact(deps, principal, artifactId),
      listRunArtifacts: (principal, projectId, runId, key) =>
        stepRunArtifactsDomain.listRunArtifacts(deps, principal, projectId, runId, key),
    },
    questions: {
      listWaiting: (principal) => stepRunQuestionsDomain.listWaitingQuestions(deps, principal),
      countWaiting: (principal) => stepRunQuestionsDomain.countWaitingQuestions(deps, principal),
      get: (principal, questionId) => stepRunQuestionsDomain.getQuestion(deps, principal, questionId),
      answer: (principal, questionId, answer) =>
        stepRunQuestionsDomain.answerQuestion(deps, principal, questionId, answer),
      mintArtifactEditUpload: (principal, questionId, sizeBytes) =>
        stepRunQuestionsDomain.mintArtifactEditUpload(deps, principal, questionId, sizeBytes),
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
    automation: {
      ingestWebhook: (input) =>
        automationDomain.ingestWebhook(
          { db: deps.db, clock: deps.clock, gitHost: deps.gitHost, githubWebhookSecret: deps.githubWebhookSecret },
          input,
        ),
      sweep: () =>
        automationDomain.sweepAutomation({
          db: deps.db,
          clock: deps.clock,
          gitHost: deps.gitHost,
          scheduleWatermark: deps.automationScheduleWatermark,
        }),
      listCronSkips: (principal, projectId, cursor, limit) =>
        automationDomain.listCronSkips(deps, principal, projectId, cursor, limit),
    },
    egress: {
      setAllowlist: (principal, projectId, allowlist) =>
        egressDomain.setProjectEgressAllowlist(deps, principal, projectId as never, allowlist),
    },
    costs: {
      stepRun: (principal, stepRunId) => costsDomain.getStepRunCost(deps, principal, stepRunId),
      run: (principal, projectId, runId) => costsDomain.getRunCost(deps, principal, projectId, runId),
      project: (principal, projectId) => costsDomain.getProjectCost(deps, principal, projectId),
    },
    editor: {
      listRepositories: (principal, projectId) =>
        pipelineEditorDomain.listProjectRepositories(deps, principal, projectId),
      openPullRequest: (principal, projectId, input) =>
        pipelineEditorDomain.openEditorPullRequest(deps, principal, projectId, input),
    },
  };
}

/** What a route handler actually receives. No `db`, no `random` — a route has no legitimate use for either directly. */
export interface RouteDeps {
  domain: Domain;
  clock: Clock;
}
