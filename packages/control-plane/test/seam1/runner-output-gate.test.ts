/**
 * Issue 9, AC6/AC7 — the control plane is the authoritative Output gate.
 * The Runner may validate for live feedback while the session is still
 * alive; `/result` is where the Output is accepted or rejected for good,
 * because it is the only thing that moves scheduling. A rejected Output
 * makes the whole turn `failed` with `reason: output-invalid`, consuming the
 * ordinary attempt, and the branch that was already pushed becomes an orphan
 * for the retention GC.
 *
 * Also AC5 — the final prompt (file content + the Runner-generated format
 * block) is pinned on the StepRun row at claim time and exposed through the
 * web run-detail surface, so the UI can show "prompt final yang dikirim",
 * not the verbatim file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, seedReadyStepRun } from "./runner-test-helpers.js";

const AGENT_DEFINITION = `version: 1
name: agent-output
repo: backend
concurrency: cancel
steps:
  plan:
    promptFile: .factory/prompts/plan.md
    timeout: 30m
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
`;

const PROMPT_TEXT = "Plan three implementation variants.\n";

describe("Runner protocol: the authoritative Output gate at /result", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("AC7 — a rejected Output makes the whole turn failed with reason output-invalid, consuming the ordinary attempt", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(
      rig.pool,
      { stepKey: "plan" },
      undefined,
      { definition: AGENT_DEFINITION, definitionFiles: { ".factory/prompts/plan.md": PROMPT_TEXT } },
    );

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string; attempt: number } }).step_run;
    expect(stepRun.id).toBe(stepRunId);

    // The agent's Output fails the gate: a field nobody declared (`nonsense`),
    // and a Key that is not git-ref-safe.
    const result = await client.result(secret, stepRun.id, {
      lease_token: stepRun.lease_token,
      outcome: "succeeded",
      ref: { branch: `run/${stepRun.id}/plan/t1-a1`, sha: "cafebabe" },
      output_data: { kind: "done", outputs: { variants: [{ key: "My Variant!", brief: "x", nonsense: 1 }] } },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: "failed" });

    const row = await rig.pool.query<{ outcome: string; reason: string | null; output_data: unknown; attempt: number }>(
      "select outcome, reason, output_data, attempt from step_runs where id = $1",
      [stepRunId],
    );
    expect(row.rows[0]).toEqual({
      outcome: "failed",
      reason: "output-invalid",
      output_data: null,
      attempt: 1, // consumed the ordinary attempt; retry (when it exists) bumps this same counter.
    });
  });

  it("AC6 — a valid done Output passes the gate and is stored", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(
      rig.pool,
      { stepKey: "plan" },
      undefined,
      { definition: AGENT_DEFINITION, definitionFiles: { ".factory/prompts/plan.md": PROMPT_TEXT } },
    );

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;

    const validOutput = { kind: "done", outputs: { variants: [{ key: "agent-a", brief: "b" }] } };
    const result = await client.result(secret, stepRun.id, {
      lease_token: stepRun.lease_token,
      outcome: "succeeded",
      ref: { branch: `run/${stepRun.id}/plan/t1-a1`, sha: "cafebabe" },
      output_data: validOutput,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: "succeeded", output_data: validOutput });

    const row = await rig.pool.query<{ outcome: string; reason: string | null; output_data: unknown }>(
      "select outcome, reason, output_data from step_runs where id = $1",
      [stepRunId],
    );
    expect(row.rows[0]).toEqual({ outcome: "succeeded", reason: null, output_data: validOutput });
  });

  it("AC7 — a run: Step with no output contract is never gated (no output_data to check)", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool);

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;

    const result = await client.result(secret, stepRun.id, {
      lease_token: stepRun.lease_token,
      outcome: "succeeded",
      ref: { branch: `run/${stepRun.id}/build/t1-a1`, sha: "cafebabe" },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: "succeeded" });
  });

  it("AC5 — the final prompt (file content + format block) is pinned at claim time and exposed by the run-detail API", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { projectId, runId, stepRunId } = await seedReadyStepRun(
      rig.pool,
      { stepKey: "plan" },
      undefined,
      { definition: AGENT_DEFINITION, definitionFiles: { ".factory/prompts/plan.md": PROMPT_TEXT } },
    );

    const claimed = await client.claim(secret);
    expect((claimed.body as { step_run: { id: string } }).step_run.id).toBe(stepRunId);

    // The web surface requires Project membership; the break-glass owner is
    // org owner, not a member, so add them like the other web-surface tests do.
    await fetch(`${rig.baseUrl}/projects/${projectId}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });

    // The web surface exposes it (the UI is scaffold-only; the data plumbing is what this AC pins).
    const detail = await fetch(`${rig.baseUrl}/projects/${projectId}/runs/${runId}`, {
      headers: { cookie: ownerCookie },
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { stepRuns: { stepKey: string; finalPrompt: string | null }[] };
    const planStep = body.stepRuns.find((s) => s.stepKey === "plan");
    expect(planStep).toBeDefined();
    expect(planStep?.finalPrompt).toContain(PROMPT_TEXT.trim());
    expect(planStep?.finalPrompt).toContain("<factory-output>");
    expect(planStep?.finalPrompt).toContain('"kind":"done"');
    // Not the verbatim file — the format block is appended.
    expect(planStep?.finalPrompt!.length).toBeGreaterThan(PROMPT_TEXT.length);
  });

  it("the claim payload resolves an interactive Step's ask.group to a Group id (spec: everything the Runner needs comes in /claim)", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const askDefinition = `version: 1
name: interactive
repo: backend
concurrency: cancel
steps:
  review:
    promptFile: prompts/review.md
    ask:
      group: reviewers
      kind: approval
`;
    const { projectId, stepRunId } = await seedReadyStepRun(
      rig.pool,
      { stepKey: "review" },
      undefined,
      { definition: askDefinition, definitionFiles: { "prompts/review.md": "Review the work.\n" } },
    );

    // Break-glass owner is org owner, not a member — add them, then create the group.
    await fetch(`${rig.baseUrl}/projects/${projectId}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });
    const created = await fetch(`${rig.baseUrl}/projects/${projectId}/groups`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ name: "reviewers" }),
    });
    expect(created.status).toBe(201);
    const group = (await created.json()) as { id: string };

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; ask_group_id: string | null } }).step_run;
    expect(stepRun.id).toBe(stepRunId);
    // The Runner never has to resolve the name — the control plane did.
    expect(stepRun.ask_group_id).toBe(group.id);
  });
});
