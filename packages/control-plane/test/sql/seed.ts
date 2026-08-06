/**
 * Minimal fixture chain for the `claim_step_run` and `retention_sweeps`
 * contract tests: a project, one repository behind it, one principal, one
 * run, and (per-test) whatever step_runs the test needs. Seeded through
 * Drizzle — the fixture data isn't what's under test, only the three hand-
 * written SQL files are (spec: "Testing Decisions").
 */
import type { Pool } from "pg";
import type { Id } from "@factory/shared";
import { createDatabase } from "../../src/db/client.js";
import {
  githubAppInstallations,
  principals,
  projects,
  repositories,
  runs,
  stepRuns,
} from "../../src/db/schema.js";
import { testIdGenerator } from "./db-rig.js";

export async function seedProjectRepoPrincipal(pool: Pool, ids: ReturnType<typeof testIdGenerator>) {
  const db = createDatabase(pool);

  const projectId = ids.next("project");
  await db.insert(projects).values({ id: projectId, name: "fixture project" });

  const installationId = ids.next("installation");
  await db.insert(githubAppInstallations).values({
    id: installationId,
    projectId,
    installationId: Math.floor(Math.random() * 1_000_000_000),
    accountLogin: "fixture-account",
  });

  const repositoryId = ids.next("repository");
  await db.insert(repositories).values({
    id: repositoryId,
    projectId,
    githubAppInstallationId: installationId,
    owner: "fixture-owner",
    name: `fixture-repo-${repositoryId}`,
    defaultBranch: "main",
  });

  const principalId = ids.next("serviceaccount");
  await db.insert(principals).values({ id: principalId, kind: "service_account" });

  return { projectId, repositoryId, principalId };
}

export interface RunFixtureOverrides {
  endedAt?: Date | null;
  artifactsPurgedAt?: Date | null;
  logsPurgedAt?: Date | null;
  branchesPurgedAt?: Date | null;
  /** The inline definition snapshot (YAML text). Defaults to an empty object — run: fixtures never read it. */
  definition?: unknown;
  definitionFiles?: Record<string, string>;
  /** Overrides `runs.triggered_by_principal_id` (defaults to the chain's principal). */
  triggeredByPrincipalId?: Id<"user"> | Id<"serviceaccount">;
  /** Overrides `runs.credential_principal_id` — the second attribution column (issue 12, AC9). Defaults to the chain's principal. */
  credentialPrincipalId?: Id<"user"> | Id<"serviceaccount">;
}

export interface RunFixtureChain {
  projectId: Id<"project">;
  repositoryId: Id<"repository">;
  principalId: Id<"user"> | Id<"serviceaccount">;
}

export async function seedRun(
  pool: Pool,
  ids: ReturnType<typeof testIdGenerator>,
  chain: RunFixtureChain,
  overrides: RunFixtureOverrides = {},
) {
  const db = createDatabase(pool);
  const runId = ids.next("run");
  await db.insert(runs).values({
    id: runId,
    projectId: chain.projectId,
    pipelineRepositoryId: chain.repositoryId,
    pipelinePath: ".factory/pipelines/ci.yaml",
    triggerKind: "manual",
    triggeredByPrincipalId: overrides.triggeredByPrincipalId ?? chain.principalId,
    credentialPrincipalId: overrides.credentialPrincipalId ?? chain.principalId,
    refBranch: "main",
    refSha: "a".repeat(40),
    definition: overrides.definition ?? {},
    definitionFiles: overrides.definitionFiles ?? {},
    endedAt: overrides.endedAt ?? null,
    artifactsPurgedAt: overrides.artifactsPurgedAt ?? null,
    logsPurgedAt: overrides.logsPurgedAt ?? null,
    branchesPurgedAt: overrides.branchesPurgedAt ?? null,
  });
  return runId;
}

export async function seedRunFixture(
  pool: Pool,
  ids: ReturnType<typeof testIdGenerator>,
  runOverrides: RunFixtureOverrides = {},
) {
  const chain = await seedProjectRepoPrincipal(pool, ids);
  const runId = await seedRun(pool, ids, chain, runOverrides);
  return { ...chain, runId };
}

export type StepRunOutcome =
  | "ready"
  | "running"
  | "awaiting-human"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "unschedulable";

export interface StepRunFixtureInput {
  runId: Id<"run">;
  repositoryId: Id<"repository">;
  stepKey?: string;
  branchKey?: string | null;
  turn?: number;
  outcome?: StepRunOutcome;
  requiredTags?: string[];
  readyAt?: Date;
  unschedulableAfter?: Date | null;
  kind?: "pull-request" | null;
  leasedBy?: string | null;
  leaseExpiresAt?: Date | null;
  sessionBlobKey?: string | null;
  sessionPurgedAt?: Date | null;
}

export async function seedStepRun(
  pool: Pool,
  ids: ReturnType<typeof testIdGenerator>,
  input: StepRunFixtureInput,
) {
  const db = createDatabase(pool);
  const id = ids.next("steprun");
  await db.insert(stepRuns).values({
    id,
    runId: input.runId,
    repositoryId: input.repositoryId,
    stepKey: input.stepKey ?? "implement",
    branchKey: input.branchKey ?? null,
    turn: input.turn ?? 1,
    outcome: input.outcome ?? "ready",
    requiredTags: input.requiredTags ?? [],
    readyAt: input.readyAt ?? new Date(),
    unschedulableAfter: input.unschedulableAfter ?? null,
    kind: input.kind ?? null,
    leasedBy: input.leasedBy ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    sessionBlobKey: input.sessionBlobKey ?? null,
    sessionPurgedAt: input.sessionPurgedAt ?? null,
  });
  return id;
}

/**
 * Seeds a `webhook_deliveries` row the retention sweep considers a
 * candidate: old enough, `processed_at` set (issue #23 — the webhook
 * candidate demands `processed_at IS NOT NULL`: only a mapped delivery may
 * lose its payload), marker NULL. `processedAt` overrides let a test prove
 * an unprocessed delivery is NOT a candidate.
 */
export async function seedWebhookDelivery(
  pool: Pool,
  deliveryId: string,
  receivedAt: Date,
  purgedAt: Date | null = null,
  processedAt: Date | null = new Date(),
): Promise<string> {
  await pool.query(
    `insert into webhook_deliveries (delivery_id, received_at, event_type, payload, purged_at, processed_at) values ($1, $2, $3, $4, $5, $6)`,
    [deliveryId, receivedAt, "push", { action: "test" }, purgedAt, processedAt],
  );
  return deliveryId;
}
