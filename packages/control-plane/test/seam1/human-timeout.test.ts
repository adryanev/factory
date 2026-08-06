/**
 * Issue #24 — `humanTimeout` is enforced (it was only ever validated and
 * serialized, never read by the control plane). Over the seam-1 rig: real
 * Postgres, real HTTP, the injected clock driving every deadline — nothing
 * here reads the wall clock.
 *
 * The acceptance criteria, mapped to the tests below:
 *  - the deadline is recorded at the moment the StepRun enters
 *    `awaiting-human` — `human_deadline = question-time + humanTimeout`,
 *    stamped once from the injected clock, never derived at sweep time
 *    (test 1), and `none` records no deadline (test 1);
 *  - an `awaiting-human` StepRun before its deadline is untouched (test 2);
 *  - past the deadline, the sweep moves the row per the Step's
 *    `onHumanTimeout`: `fail` ends the StepRun and advances the Graph
 *    (test 3), `continue` (and an omitted `onHumanTimeout`, the same lenient
 *    default `onReject` carries) moves the conversation on without an
 *    answer — the turn ends and a new turn is born carrying the session and
 *    a rendered "no answer" prompt (tests 5 and 6);
 *  - the sweep is observable and safe to re-run: the state is served by the
 *    runs API and a second sweep transitions nothing (tests 3 and 4).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { sweepExpiredLeases, sweepHumanTimeouts } from "../../src/domain/step-run-ops.js";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, seedReadyStepRun, type JoinedRunner } from "./runner-test-helpers.js";

const PROMPT_TEXT = "Review the work.\n";

let fixtureCounter = 2000;

/** `humanTimeout` with an explicit `onHumanTimeout: fail` and a downstream Step to observe the Graph advance. */
const WITH_FAIL = `version: 1
name: interactive
repo: backend
concurrency: cancel
steps:
  review:
    promptFile: prompts/review.md
    ask:
      group: reviewers
      kind: approval
    humanTimeout: 2h
    onHumanTimeout: fail
  test:
    after: [review]
    run: "echo test"
`;

/** `humanTimeout` with an explicit `onHumanTimeout: continue`. */
const WITH_CONTINUE = `version: 1
name: interactive
repo: backend
concurrency: cancel
steps:
  review:
    promptFile: prompts/review.md
    ask:
      group: reviewers
      kind: approval
    humanTimeout: 2h
    onHumanTimeout: continue
`;

/** `humanTimeout` with `onHumanTimeout` omitted — the runtime default must be defined, not a silent no-op. */
const WITH_TIMEOUT_ONLY = `version: 1
name: interactive
repo: backend
concurrency: cancel
steps:
  review:
    promptFile: prompts/review.md
    ask:
      group: reviewers
      kind: approval
    humanTimeout: 2h
`;

/** `humanTimeout: none` — the schema default, no deadline at all. */
const WITH_NONE = `version: 1
name: interactive
repo: backend
concurrency: cancel
steps:
  review:
    promptFile: prompts/review.md
    ask:
      group: reviewers
      kind: approval
    humanTimeout: none
`;

interface ClaimedStepRun {
  id: string;
  lease_token: string;
  turn: number;
}

/** The `reviewers` Group of a project with the given principals as members (adapted from questions.test.ts). */
async function createReviewerGroup(
  rig: TestRig,
  ownerCookie: string,
  ownerPrincipalId: string,
  projectId: string,
  members: string[],
): Promise<string> {
  await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/members/self`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  const groupResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/groups`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ name: "reviewers" }),
  });
  expect(groupResponse.status).toBe(201);
  const group = (await groupResponse.json()) as { id: string };
  for (const principalId of members) {
    if (principalId !== ownerPrincipalId) {
      const asMember = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ principalId, role: "member" }),
      });
      expect(asMember.status).toBe(200);
    }
    const added = await rig.fetchWithCsrf(`${rig.baseUrl}/groups/${group.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ principalId }),
    });
    expect(added.status).toBe(200);
  }
  return group.id;
}

/** Seeds an interactive StepRun with the given definition, claims it, uploads a session, and POSTs a Question — the row now sits `awaiting-human` with its deadline recorded. */
async function claimAndAsk(
  rig: TestRig,
  ownerCookie: string,
  ownerPrincipalId: string,
  runner: JoinedRunner,
  definition: string,
): Promise<{ questionId: string; stepRun: ClaimedStepRun; runId: string }> {
  const seeded = await seedReadyStepRun(
    rig.pool,
    { stepKey: "review" },
    undefined,
    { definition, definitionFiles: { "prompts/review.md": PROMPT_TEXT } },
  );
  // The definitions name the repo `backend` (pipeline.repo) — rename the
  // seeded repository so downstream Steps can be materialized by the Graph
  // advance, which resolves `repo:` by name. (owner, name) is unique, so a
  // per-fixture owner keeps the shared rig's rows apart.
  fixtureCounter += 1;
  await rig.pool.query("update repositories set owner = $1, name = 'backend' where id = $2", [
    `ht-owner-${fixtureCounter}`,
    seeded.repositoryId,
  ]);
  const groupId = await createReviewerGroup(rig, ownerCookie, ownerPrincipalId, seeded.projectId, [ownerPrincipalId]);

  const claimed = await runner.client.claim(runner.secret);
  const stepRun = (claimed.body as { step_run: ClaimedStepRun }).step_run;
  expect(stepRun.id).toBe(seeded.stepRunId);

  const sessionJsonl = '{"type":"turn-1"}\n';
  const grants = await runner.client.uploads(runner.secret, stepRun.id, {
    lease_token: stepRun.lease_token,
    requests: [{ key: "sess-abc.jsonl", kind: "session" }],
  });  const grant = (grants.body as { grants: { key: string; upload_url: string; blob_key: string }[] }).grants[0]!;
  rig.objectStore.putFromUrl(grant.upload_url, sessionJsonl);

  const asked = await runner.client.question(runner.secret, stepRun.id, {
    lease_token: stepRun.lease_token,
    question: {
      id: generateId("question"),
      group_id: groupId,
      kind: "approval",
      body: "Approve this plan?",
    },
    ref: { branch: `run/${stepRun.id}/review/t1-a1`, sha: "cafebabe" },
    session_blob_key: grant.blob_key,
    session_id: "sess-abc",
  });
  expect(asked.status).toBe(200);
  return { questionId: (asked.body).question_id, stepRun, runId: seeded.runId };
}

/** Removes a fixture's rows from the shared rig's consideration so later claims are deterministic. */
async function cancelRow(rig: TestRig, stepRunId: string): Promise<void> {
  await rig.pool.query(`update step_runs set outcome = 'cancelled', reason = 'test-cleanup' where id = $1`, [
    stepRunId,
  ]);
}

async function outcomeOf(rig: TestRig, stepRunId: string): Promise<{ outcome: string; reason: string | null }> {
  const { rows } = await rig.pool.query<{ outcome: string; reason: string | null }>(
    "select outcome, reason from step_runs where id = $1",
    [stepRunId],
  );
  return rows[0]!;
}

describe("humanTimeout", () => {
  let rig: TestRig;
  let ownerCookie: string;
  let ownerPrincipalId: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
    const { rows } = await rig.pool.query<{ principal_id: string }>(
      "select principal_id from users where password_hash is not null limit 1",
    );
    ownerPrincipalId = rows[0]!.principal_id;
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("records the deadline at the moment the StepRun enters awaiting-human: human_deadline = question-time + humanTimeout, from the injected clock; none records no deadline", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const runner = await joinRunner(rig, ownerCookie);
    const timed = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, WITH_FAIL);

    const { rows } = await rig.pool.query<{ human_deadline: Date | null }>(
      "select human_deadline from step_runs where id = $1",
      [timed.stepRun.id],
    );
    // The reference point is the rig clock's question instant, not the
    // database server's wall clock.
    expect(rows[0]!.human_deadline).not.toBeNull();
    expect(rows[0]!.human_deadline!.getTime()).toBe(new Date("2026-01-01T02:00:00.000Z").getTime());

    const none = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, WITH_NONE);
    const noneRow = await rig.pool.query<{ human_deadline: Date | null }>(
      "select human_deadline from step_runs where id = $1",
      [none.stepRun.id],
    );
    expect(noneRow.rows[0]!.human_deadline).toBeNull();

    await cancelRow(rig, timed.stepRun.id);
    await cancelRow(rig, none.stepRun.id);
  });

  it("before the deadline, the sweep leaves the awaiting-human StepRun untouched", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, WITH_FAIL);

    rig.setClock(new Date("2026-01-01T01:00:00.000Z")); // 1h elapsed, deadline is at 2h
    await sweepExpiredLeases(rig.deps);

    expect(await outcomeOf(rig, stepRun.id)).toEqual({ outcome: "awaiting-human", reason: null });

    await cancelRow(rig, stepRun.id);
  });

  it("past the deadline with onHumanTimeout: fail — the sweep fails the StepRun, its dependent is skipped, the Run ends failed, the state is served by the runs API, and the Question leaves the waiting list", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const runner = await joinRunner(rig, ownerCookie);
    const { questionId, stepRun, runId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, WITH_FAIL);

    const waitingBefore = await fetch(`${rig.baseUrl}/questions/waiting`, { headers: { cookie: ownerCookie } });
    const beforeList = (await waitingBefore.json()) as { questions: { id: string }[] };
    expect(beforeList.questions.map((q) => q.id)).toContain(questionId);

    rig.setClock(new Date("2026-01-01T03:00:00.000Z"));
    await sweepExpiredLeases(rig.deps);

    expect(await outcomeOf(rig, stepRun.id)).toEqual({ outcome: "failed", reason: "human-timeout" });

    const { rows } = await rig.pool.query<{ id: string; outcome: string }>(
      "select id, outcome from step_runs where run_id = $1 order by step_key",
      [runId],
    );
    const dependent = rows.find((row) => row.id !== stepRun.id)!;
    expect(dependent.outcome).toBe("skipped");

    const run = await rig.pool.query<{ outcome: string | null }>("select outcome from runs where id = $1", [runId]);
    expect(run.rows[0]!.outcome).toBe("failed");

    // The explainable state is what the UI reads.
    const project = await rig.pool.query<{ project_id: string }>("select project_id from runs where id = $1", [runId]);
    const detailResponse = await rig.fetchWithCsrf(
      `${rig.baseUrl}/projects/${project.rows[0]!.project_id}/runs/${runId}`,
      { headers: { cookie: ownerCookie } },
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      stepRuns: { id: string; outcome: string; reason: string | null }[];
    };
    const served = detail.stepRuns.find((stepRun_) => stepRun_.id === stepRun.id)!;
    expect(served.outcome).toBe("failed");
    expect(served.reason).toBe("human-timeout");

    // The timed-out Question is no longer answerable — the waiting list reads
    // awaiting-human StepRuns, so the failed row's Question vanishes.
    const waitingAfter = await fetch(`${rig.baseUrl}/questions/waiting`, { headers: { cookie: ownerCookie } });
    const afterList = (await waitingAfter.json()) as { questions: { id: string }[] };
    expect(afterList.questions.map((q) => q.id)).not.toContain(questionId);
  });

  it("the sweep is safe to re-run: a second sweep transitions nothing", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, WITH_FAIL);

    rig.setClock(new Date("2026-01-01T03:00:00.000Z"));
    const first = await sweepHumanTimeouts({ db: rig.deps.db, clock: rig.deps.clock });
    expect(first).toEqual([stepRun.id]);

    const second = await sweepHumanTimeouts({ db: rig.deps.db, clock: rig.deps.clock });
    expect(second).toEqual([]);
    expect((await outcomeOf(rig, stepRun.id)).outcome).toBe("failed");

    await cancelRow(rig, stepRun.id);
  });

  it("past the deadline with onHumanTimeout: continue — the turn ends and a new turn is born carrying the session and a rendered no-answer prompt, claimable by any Runner", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun, runId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, WITH_CONTINUE);

    rig.setClock(new Date("2026-01-01T03:00:00.000Z"));
    await sweepExpiredLeases(rig.deps);

    // The timed-out turn ends as a completed turn; the conversation moves on.
    expect(await outcomeOf(rig, stepRun.id)).toEqual({ outcome: "succeeded", reason: null });

    const { rows } = await rig.pool.query<{
      id: string;
      turn: number;
      outcome: string;
      session_blob_key: string | null;
      session_id: string | null;
      resume_prompt: string | null;
    }>("select id, turn, outcome, session_blob_key, session_id, resume_prompt from step_runs where run_id = $1 order by turn asc", [runId]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: stepRun.id, turn: 1, outcome: "succeeded" });
    const next = rows[1]!;
    expect(next).toMatchObject({
      turn: 2,
      outcome: "ready",
      session_blob_key: `session/${stepRun.id}/sess-abc.jsonl`,
      session_id: "sess-abc",
    });
    // The no-answer notice is the next turn's prompt, rendered like an answer.
    expect(next.resume_prompt).toContain("Approve this plan?");
    expect(next.resume_prompt).toContain("No one answered");

    // The born turn is an ordinary ready row — a Runner claims it.
    const resumed = await runner.client.claim(runner.secret);
    expect((resumed.body as { step_run: { id: string } | null }).step_run?.id).toBe(next.id);
    await cancelRow(rig, next.id);
  });

  it("onHumanTimeout omitted with humanTimeout set — the runtime default continues the conversation, never a silent no-op", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun, runId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, WITH_TIMEOUT_ONLY);

    rig.setClock(new Date("2026-01-01T03:00:00.000Z"));
    await sweepExpiredLeases(rig.deps);

    expect(await outcomeOf(rig, stepRun.id)).toEqual({ outcome: "succeeded", reason: null });
    const { rows } = await rig.pool.query<{ id: string; turn: number; outcome: string }>(
      "select id, turn, outcome from step_runs where run_id = $1 order by turn asc",
      [runId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ turn: 2, outcome: "ready" });
    await cancelRow(rig, rows[1]!.id);
  });
});
