/**
 * Shared setup for the Runner-protocol seam-1 tests: mint a join token as
 * the org owner (break-glass, per `bootstrapBreakGlassAccount`), join with
 * it as an ordinary HTTP client, optionally set operator policy, and seed a
 * `ready` StepRun to claim. StepRun/Run/Project fixtures are seeded through
 * `test/sql/seed.ts` — the same helpers `claim_step_run.sql`'s own contract
 * test uses — deliberately, since this issue does not own Graph
 * materialization (issue #4 does) and must not invent a second way to get a
 * `ready` row into Postgres.
 */
import type { Pool } from "pg";
import { generateId, type Id, type IdPrefix } from "@factory/shared";
import { createRunnerClient, type RunnerClient } from "./fake-runner-client.js";
import { seedRunFixture, seedStepRun, type StepRunFixtureInput } from "../sql/seed.js";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "../../src/csrf.js";
import type { TestRig } from "./setup.js";

/**
 * A real (non-deterministic) id generator, structurally matching what
 * `test/sql/seed.ts`'s helpers expect. Deliberately not
 * `test/sql/db-rig.ts`'s `testIdGenerator` — that one exists for the
 * hand-written-SQL contract tests, which reset the whole database between
 * every test (`resetDatabase`) and want deterministic ids for that reason.
 * This rig's Postgres container is shared across every test in a describe
 * block with no reset, so two tests each starting a *fresh*
 * `testIdGenerator()` (counter always restarting at 1, same fixed base
 * timestamp) would mint the identical `project_...` id and collide on the
 * primary key — which is exactly what happened before this existed.
 */
export interface IdGenerator {
  next<P extends IdPrefix>(prefix: P): Id<P>;
}

export function realIdGenerator(): IdGenerator {
  return { next: (prefix) => generateId(prefix) };
}

export async function mintJoinToken(rig: TestRig, ownerCookie: string): Promise<string> {
  const response = await fetch(`${rig.baseUrl}/runner-joins`, {
    method: "POST",
    headers: { cookie: ownerCookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  if (response.status !== 201) {
    throw new Error(`mint join token failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}

export async function setRunnerPolicy(
  rig: TestRig,
  ownerCookie: string,
  runnerId: string,
  policy: { slots: number; tags: string[] },
): Promise<void> {
  const response = await fetch(`${rig.baseUrl}/runners/${runnerId}/policy`, {
    method: "POST",
    headers: { cookie: ownerCookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  if (response.status !== 200) {
    throw new Error(`set policy failed: ${response.status} ${await response.text()}`);
  }
}

export interface JoinedRunner {
  runnerId: string;
  secret: string;
  client: RunnerClient;
}

/** Joins a fresh Runner as an org owner would provision one, with policy `{slots, tags}` applied. */
export async function joinRunner(
  rig: TestRig,
  ownerCookie: string,
  policy: { slots: number; tags: string[] } = { slots: 10, tags: [] },
): Promise<JoinedRunner> {
  const client = createRunnerClient(rig.baseUrl);
  const token = await mintJoinToken(rig, ownerCookie);
  const { status, body } = await client.join(token);
  if (status !== 200) {
    throw new Error(`join failed: ${status} ${JSON.stringify(body)}`);
  }
  const { runner_id: runnerId, secret } = body as { runner_id: string; secret: string };
  await setRunnerPolicy(rig, ownerCookie, runnerId, policy);
  return { runnerId, secret, client };
}

export interface SeededReadyStepRun {
  projectId: string;
  repositoryId: string;
  runId: string;
  stepRunId: string;
}

/**
 * Seeds a Project/Repository/Run and one `ready` StepRun directly through
 * Drizzle — the same fixture chain `claim_step_run.sql`'s contract test
 * uses. Pass a shared `ids` generator (`testIdGenerator()`) across multiple
 * calls within one test — each generator instance's counter starts fresh,
 * so two independently-constructed ones produce colliding ids (both mint
 * `project` #1 first).
 */
export async function seedReadyStepRun(
  pool: Pool,
  overrides: Partial<StepRunFixtureInput> = {},
  ids: IdGenerator = realIdGenerator(),
  runOverrides: { definition?: unknown; definitionFiles?: Record<string, string> } = {},
): Promise<SeededReadyStepRun> {
  const fixture = await seedRunFixture(pool, ids, runOverrides);
  const stepRunId = await seedStepRun(pool, ids, {
    runId: fixture.runId,
    repositoryId: fixture.repositoryId,
    ...overrides,
  });
  return {
    projectId: fixture.projectId,
    repositoryId: fixture.repositoryId,
    runId: fixture.runId,
    stepRunId,
  };
}
