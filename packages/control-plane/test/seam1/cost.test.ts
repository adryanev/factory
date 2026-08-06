/**
 * Issue 12 — "Cost dan token tracking". The two rules the whole surface
 * exists for: "yang tidak ada tidak diperkirakan; yang sudah ditulis tidak
 * dihitung ulang". An agent that reported no usage shows "tidak didukung",
 * never an estimate; a cost written once at StepRun end with its
 * `price_version` is never recomputed when the price table changes.
 *
 * Proves the acceptance criteria end to end through the HTTP surface:
 *  - AC3/AC4/AC5 — write-once cost per attempt, keyed (step_run_id, attempt),
 *    insert-only, cumulative is a plain sum;
 *  - AC6 — the per-attempt breakdown is visible;
 *  - AC7 — the three aggregations live on their own endpoints;
 *  - AC8 — the running cost shows while the Run is in flight;
 *  - AC9 — attribution splits by `credential_principal_id`;
 *  - AC1 — no usage → `supported: false` (the UI's "tidak didukung").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Id } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, realIdGenerator, type IdGenerator } from "./runner-test-helpers.js";
import type { RunnerClient } from "./fake-runner-client.js";
import { seedProjectRepoPrincipal, seedRun, seedStepRun } from "../sql/seed.js";

const PLAN_PROMPT = "Plan three implementation variants.\n";

function agentPipeline(repoName: string, extraSteps: string = ""): string {
  return `version: 1
name: cost-pipeline
repo: ${repoName}
concurrency: cancel
steps:
  plan:
    promptFile: .factory/prompts/plan.md
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
${extraSteps}`;
}

const TWO_STEP_PIPELINE = (repoName: string) =>
  agentPipeline(repoName, `  build:
    run: make build
    after: [plan]
`);

const DONE_WITH_USAGE = (inputTokens: number, outputTokens = 0) => ({
  kind: "done" as const,
  outputs: { variants: [{ key: "agent-a", brief: "b" }] },
  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
});

async function addOwnerAsMember(rig: TestRig, ownerCookie: string, projectId: string): Promise<void> {
  const response = await fetch(`${rig.baseUrl}/projects/${projectId}/members/self`, {
    method: "POST",
    headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
  });
  expect(response.status).toBe(200);
}

/**
 * The rig's Postgres container is shared across every test in this suite, so
 * the price table's "current" version is whatever the previous test left
 * behind. Tests that assert exact dollar figures therefore pin their own
 * current version (insert-only — a fresh row, effective now) before pricing.
 */
async function setCurrentPrice(rig: TestRig, version: string, inputPrice: string, outputPrice: string): Promise<void> {
  await rig.pool.query(
    `insert into price_versions (version, effective_at, input_token_usd_per_million, output_token_usd_per_million, note)
     values ($1, now(), $2, $3, 'cost.test.ts fixture')`,
    [version, inputPrice, outputPrice],
  );
}

/** Seeds a project/repo/run/one `plan` StepRun with an agent definition and returns the ids plus the repo name the definition must use. */
async function seedPlanRun(
  rig: TestRig,
  ids: IdGenerator,
  overrides: { runId?: Id<"run">; definition?: string } = {},
): Promise<{ projectId: string; repositoryId: string; runId: Id<"run">; stepRunId: string; repoName: string }> {
  const chain = await seedProjectRepoPrincipal(rig.pool, ids);
  const repoName = `fixture-repo-${chain.repositoryId}`;
  const definition = overrides.definition ?? agentPipeline(repoName);
  const runId =
    overrides.runId ??
    (await seedRun(rig.pool, ids, chain, {
      definition,
      definitionFiles: { ".factory/prompts/plan.md": PLAN_PROMPT },
    }));
  const stepRunId = await seedStepRun(rig.pool, ids, {
    runId,
    repositoryId: chain.repositoryId,
    stepKey: "plan",
  });
  return { projectId: chain.projectId, repositoryId: chain.repositoryId, runId, stepRunId, repoName };
}

async function claimAndResult(
  rig: TestRig,
  secret: string,
  client: RunnerClient,
  input: { output_data?: unknown; outcome?: "succeeded" | "failed" },
): Promise<{ id: string; lease_token: string; attempt: number }> {
  const claimed = await client.claim(secret);
  const stepRun = (claimed.body as { step_run: { id: string; lease_token: string; attempt: number } }).step_run;
  const result = await client.result(secret, stepRun.id, {
    lease_token: stepRun.lease_token,
    outcome: input.outcome ?? "succeeded",
    ref: { branch: `run/${stepRun.id}/plan/t1-a${stepRun.attempt}`, sha: "cafebabe" },
    ...(input.output_data !== undefined ? { output_data: input.output_data } : {}),
  });
  expect(result.status).toBe(200);
  return stepRun;
}

describe("Cost — write-once pricing and the three aggregations", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("AC3/AC4 — a reported usage is priced once at /result, stored with the price_version, keyed (step_run_id, attempt)", async () => {
    const ids = realIdGenerator();
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { projectId } = await seedPlanRun(rig, ids);
    await addOwnerAsMember(rig, ownerCookie, projectId);

    const stepRun = await claimAndResult(rig, secret, client, {
      output_data: DONE_WITH_USAGE(1_000_000),
    });

    const rows = await rig.pool.query<{
      attempt: number;
      tokens: unknown;
      cost_usd: string;
      price_version: string;
    }>("select attempt, tokens, cost_usd, price_version from step_run_costs where step_run_id = $1", [stepRun.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({
      attempt: 1,
      tokens: { input_tokens: 1_000_000, output_tokens: 0 },
      cost_usd: "3.000000", // 1,000,000 input × $3/M, priced against the seeded v1 table.
      price_version: "v1",
    });

    const costResponse = await fetch(`${rig.baseUrl}/step-runs/${stepRun.id}/cost`, {
      headers: { cookie: ownerCookie },
    });
    expect(costResponse.status).toBe(200);
    const body = (await costResponse.json()) as {
      totalCostUsd: string;
      attempts: { attempt: number; supported: boolean; tokens: unknown; costUsd: string; priceVersion: string }[];
    };
    expect(body.totalCostUsd).toBe("3.000000");
    expect(body.attempts).toEqual([
      { attempt: 1, supported: true, tokens: { inputTokens: 1_000_000, outputTokens: 0 }, costUsd: "3.000000", priceVersion: "v1" },
    ]);
  });

  it("AC1 — an agent that reports no usage gets a row with NULLs, shown as 'tidak didukung' (supported: false), never an estimate", async () => {
    const ids = realIdGenerator();
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { projectId } = await seedPlanRun(rig, ids);
    await addOwnerAsMember(rig, ownerCookie, projectId);

    const stepRun = await claimAndResult(rig, secret, client, {
      output_data: { kind: "done", outputs: { variants: [{ key: "agent-a", brief: "b" }] } },
    });

    const rows = await rig.pool.query<{ attempt: number; tokens: unknown; cost_usd: string; price_version: string }>(
      "select attempt, tokens, cost_usd, price_version from step_run_costs where step_run_id = $1",
      [stepRun.id],
    );
    expect(rows.rows[0]).toEqual({ attempt: 1, tokens: null, cost_usd: null, price_version: null });

    const costResponse = await fetch(`${rig.baseUrl}/step-runs/${stepRun.id}/cost`, {
      headers: { cookie: ownerCookie },
    });
    const body = (await costResponse.json()) as { attempts: { attempt: number; supported: boolean; costUsd: string }[] };
    expect(body.attempts[0]).toMatchObject({ attempt: 1, supported: false, costUsd: null });
  });

  it("AC3 — a later price version never rewrites an already-written cost; new attempts use the new version", async () => {
    const ids = realIdGenerator();
    const { secret, client } = await joinRunner(rig, ownerCookie);

    // One project, two runs — the first priced against the seeded v1 table,
    // the second against a freshly-appended v2.
    const chain = await seedProjectRepoPrincipal(rig.pool, ids);
    const repoName = `fixture-repo-${chain.repositoryId}`;
    const definition = agentPipeline(repoName);
    const definitionFiles = { ".factory/prompts/plan.md": PLAN_PROMPT };
    await addOwnerAsMember(rig, ownerCookie, chain.projectId);

    const runA = await seedRun(rig.pool, ids, chain, { definition, definitionFiles });
    await seedStepRun(rig.pool, ids, { runId: runA, repositoryId: chain.repositoryId, stepKey: "plan" });
    const first = await claimAndResult(rig, secret, client, { output_data: DONE_WITH_USAGE(1_000_000) });

    // Operator appends v2 (insert-only) with doubled prices.
    await rig.pool.query(
      `insert into price_versions (version, effective_at, input_token_usd_per_million, output_token_usd_per_million, note)
       values ('v2', '2026-02-01T00:00:00.000Z', 6.000000, 30.000000, 'doubled')`,
    );

    // A second run, priced after the change.
    const runB = await seedRun(rig.pool, ids, chain, { definition, definitionFiles });
    const stepRunB = await seedStepRun(rig.pool, ids, { runId: runB, repositoryId: chain.repositoryId, stepKey: "plan" });
    const second = await claimAndResult(rig, secret, client, { output_data: DONE_WITH_USAGE(1_000_000) });

    const stored = await rig.pool.query<{ step_run_id: string; cost_usd: string; price_version: string }>(
      "select step_run_id, cost_usd, price_version from step_run_costs where step_run_id in ($1, $2) order by cost_usd",
      [first.id, second.id],
    );
    expect(stored.rows).toEqual([
      { step_run_id: first.id, cost_usd: "3.000000", price_version: "v1" },
      { step_run_id: second.id, cost_usd: "6.000000", price_version: "v2" },
    ]);

    // The display is the stored numbers — nothing multiplies the price table again.
    const runACost = await fetch(`${rig.baseUrl}/projects/${chain.projectId}/runs/${runA}/cost`, {
      headers: { cookie: ownerCookie },
    });
    expect((await runACost.json()) as { totalCostUsd: string }).toMatchObject({ totalCostUsd: "3.000000" });
    const runBCost = await fetch(`${rig.baseUrl}/projects/${chain.projectId}/runs/${runB}/cost`, {
      headers: { cookie: ownerCookie },
    });
    expect((await runBCost.json()) as { totalCostUsd: string }).toMatchObject({ totalCostUsd: "6.000000" });

    // The StepRun cost endpoint carries each attempt's own pin.
    const stepRunCost = await fetch(`${rig.baseUrl}/step-runs/${stepRunB}/cost`, {
      headers: { cookie: ownerCookie },
    });
    const stepRunBody = (await stepRunCost.json()) as { attempts: { priceVersion: string }[] };
    expect(stepRunBody.attempts[0]?.priceVersion).toBe("v2");
  });

  it("AC4/AC5/AC6 — retries are extra rows, never overwrites; the per-attempt breakdown and cumulative sum are visible", async () => {
    const ids = realIdGenerator();
    const { secret, client } = await joinRunner(rig, ownerCookie);
    await setCurrentPrice(rig, "v-cost-retry", "3.000000", "15.000000");
    const { projectId, stepRunId } = await seedPlanRun(rig, ids);
    await addOwnerAsMember(rig, ownerCookie, projectId);

    // Attempt 1 fails — a failed turn records no usage, so its row is NULL.
    const attempt1 = await claimAndResult(rig, secret, client, { outcome: "failed" });
    expect(attempt1.attempt).toBe(1);

    // The lease sweep would reschedule this as attempt 2.
    await rig.pool.query(
      `update step_runs set outcome = 'ready', attempt = attempt + 1, leased_by = null, lease_token = null, lease_expires_at = null
       where id = $1`,
      [stepRunId],
    );

    // Attempt 2 succeeds and reports usage — a new row, keyed (step_run_id, 2).
    const attempt2 = await claimAndResult(rig, secret, client, { output_data: DONE_WITH_USAGE(500_000) });
    expect(attempt2.attempt).toBe(2);

    const rows = await rig.pool.query<{ attempt: number; cost_usd: string }>(
      "select attempt, cost_usd from step_run_costs where step_run_id = $1 order by attempt",
      [stepRunId],
    );
    expect(rows.rows).toEqual([
      { attempt: 1, cost_usd: null }, // the retry could not and did not touch it
      { attempt: 2, cost_usd: "1.500000" }, // 500,000 input × $3/M
    ]);

    const costResponse = await fetch(`${rig.baseUrl}/step-runs/${stepRunId}/cost`, {
      headers: { cookie: ownerCookie },
    });
    const body = (await costResponse.json()) as {
      totalCostUsd: string;
      attempts: { attempt: number; supported: boolean; costUsd: string }[];
    };
    expect(body.totalCostUsd).toBe("1.500000"); // a plain SUM across attempts
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0]).toMatchObject({ attempt: 1, supported: false, costUsd: null });
    expect(body.attempts[1]).toMatchObject({ attempt: 2, supported: true, costUsd: "1.500000" });
  });

  it("AC8 — the running cost shows while the Run is in flight (the cancel-button screen's data), then stands once it ends", async () => {
    const ids = realIdGenerator();
    const { secret, client } = await joinRunner(rig, ownerCookie);
    await setCurrentPrice(rig, "v-cost-running", "3.000000", "15.000000");

    // Two-step pipeline: plan (agent, priced) then build (run:, no usage).
    const chain = await seedProjectRepoPrincipal(rig.pool, ids);
    const repoName = `fixture-repo-${chain.repositoryId}`;
    const runId = await seedRun(rig.pool, ids, chain, {
      definition: TWO_STEP_PIPELINE(repoName),
      definitionFiles: { ".factory/prompts/plan.md": PLAN_PROMPT },
    });
    await seedStepRun(rig.pool, ids, {
      runId,
      repositoryId: chain.repositoryId,
      stepKey: "plan",
    });
    await addOwnerAsMember(rig, ownerCookie, chain.projectId);

    await claimAndResult(rig, secret, client, { output_data: DONE_WITH_USAGE(1_000_000) });

    // The Run is still in flight (build is now ready) — the cost is the running cost.
    const running = (await fetch(`${rig.baseUrl}/projects/${chain.projectId}/runs/${runId}/cost`, {
      headers: { cookie: ownerCookie },
    }).then((r) => r.json())) as { totalCostUsd: string; runEnded: boolean; unsupportedAttempts: number };
    expect(running).toMatchObject({ totalCostUsd: "3.000000", runEnded: false, unsupportedAttempts: 0 });

    // The build step's turn commits with no usage — an unsupported row — and ends the Run.
    await claimAndResult(rig, secret, client, {});

    const ended = (await fetch(`${rig.baseUrl}/projects/${chain.projectId}/runs/${runId}/cost`, {
      headers: { cookie: ownerCookie },
    }).then((r) => r.json())) as { totalCostUsd: string; runEnded: boolean; unsupportedAttempts: number; supportedAttempts: number };
    expect(ended).toMatchObject({
      totalCostUsd: "3.000000", // the sum of completed attempts — unchanged, still stored numbers
      runEnded: true,
      supportedAttempts: 1,
      unsupportedAttempts: 1,
    });
  });

  it("AC2/AC7/AC9 — the Project total is an explicit lower bound, broken down by the credential principal used", async () => {
    const ids = realIdGenerator();
    const { secret, client } = await joinRunner(rig, ownerCookie);
    await setCurrentPrice(rig, "v-cost-project", "3.000000", "15.000000");

    const chain = await seedProjectRepoPrincipal(rig.pool, ids);
    const repoName = `fixture-repo-${chain.repositoryId}`;
    await addOwnerAsMember(rig, ownerCookie, chain.projectId);

    // A second principal to attribute a Run to — the two attribution columns
    // on `runs` (spec: "Cost") differ when shared-credential fallback engaged.
    const principalB = ids.next("user");
    await rig.pool.query("insert into principals (id, kind) values ($1, 'user')", [principalB]);

    // Run A — the Project's own ServiceAccount credential.
    const runA = await seedRun(rig.pool, ids, chain, {
      definition: agentPipeline(repoName),
      definitionFiles: { ".factory/prompts/plan.md": PLAN_PROMPT },
      credentialPrincipalId: chain.principalId,
    });
    await seedStepRun(rig.pool, ids, { runId: runA, repositoryId: chain.repositoryId, stepKey: "plan" });

    // Run B — a User-triggered Run on the shared credential (different principal).
    const runB = await seedRun(rig.pool, ids, chain, {
      definition: agentPipeline(repoName),
      definitionFiles: { ".factory/prompts/plan.md": PLAN_PROMPT },
      credentialPrincipalId: principalB,
    });
    await seedStepRun(rig.pool, ids, { runId: runB, repositoryId: chain.repositoryId, stepKey: "plan" });

    await claimAndResult(rig, secret, client, { output_data: DONE_WITH_USAGE(1_000_000) });
    await claimAndResult(rig, secret, client, { output_data: DONE_WITH_USAGE(2_000_000) });

    const projectCost = (await fetch(`${rig.baseUrl}/projects/${chain.projectId}/cost`, {
      headers: { cookie: ownerCookie },
    }).then((r) => r.json())) as {
      totalCostUsd: string;
      lowerBound: boolean;
      byCredentialPrincipal: { credentialPrincipalId: string; costUsd: string }[];
    };
    expect(projectCost).toMatchObject({
      totalCostUsd: "9.000000", // 3.000000 (A) + 6.000000 (B) — the stored numbers, summed
      lowerBound: true,
    });
    expect(projectCost.byCredentialPrincipal).toEqual([
      { credentialPrincipalId: principalB, costUsd: "6.000000" },
      { credentialPrincipalId: chain.principalId, costUsd: "3.000000" },
    ]);
  });

  it("the cost endpoints are Project-member-gated — 403 without membership, 200 with it", async () => {
    const ids = realIdGenerator();
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { projectId, runId, stepRunId } = await seedPlanRun(rig, ids);

    await claimAndResult(rig, secret, client, { output_data: DONE_WITH_USAGE(1_000_000) });

    // The break-glass owner is org owner, NOT a member — the same gate every
    // web-surface read enforces (spec: "owner org tidak otomatis dapat akses
    // data Project").
    for (const path of [
      `/step-runs/${stepRunId}/cost`,
      `/projects/${projectId}/runs/${runId}/cost`,
      `/projects/${projectId}/cost`,
    ]) {
      const response = await fetch(`${rig.baseUrl}${path}`, { headers: { cookie: ownerCookie } });
      expect(response.status).toBe(403);
    }

    await addOwnerAsMember(rig, ownerCookie, projectId);
    const allowed = await fetch(`${rig.baseUrl}/projects/${projectId}/cost`, { headers: { cookie: ownerCookie } });
    expect(allowed.status).toBe(200);
  });
});
