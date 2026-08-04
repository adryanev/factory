/**
 * Issue 13 — Step human-in-the-loop, over real HTTP against the seam-1 rig:
 * the Runner's `/claim` → `/question` commit point, the human's answering
 * write, and the next turn landing on any free machine.
 *
 * The ACs under test, mapped to the tests below:
 *  - AC1: `awaiting-human` releases the lease and slot — the Runner can drain
 *    while the conversation hangs, and the next turn is claimed by a *different*
 *    machine.
 *  - AC2: the session travels via the blob store — a `session/…` PUT is minted
 *    and recorded before POST Question, and a resumed turn's claim carries a
 *    presigned GET.
 *  - AC3: two separate numberings — an answer births a new StepRun row at
 *    `turn + 1, attempt: 1`.
 *  - AC5: `approved: false` is data — with `onReject: fail` the StepRun fails
 *    and the Run ends; with `onReject: continue` (the default) a new turn is
 *    born carrying the rejection as its resume prompt.
 *  - AC6: the Question addresses a Group; the answering principal is recorded.
 *  - AC7: one open Question per StepRun (partial unique index).
 *  - AC8: losing the answering race is state — 409 carries the latest Question
 *    plus the winner's identity and the loser's own typed text.
 *  - AC10: cancel while awaiting-human is a pure DB row write (the operator
 *    cancel endpoint, no Runner endpoint involved).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, seedReadyStepRun, type JoinedRunner } from "./runner-test-helpers.js";

const APPROVAL_DEFINITION = `version: 1
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

const PROMPT_TEXT = "Review the work.\n";

async function githubLogin(rig: TestRig, githubUserId: number): Promise<{ cookie: string; principalId: string }> {
  const cookie = await rig.loginAsGithub({
    githubUserId,
    githubLogin: `user-${githubUserId}`,
    name: null,
    avatarUrl: null,
  });
  const { rows } = await rig.pool.query<{ principal_id: string }>(
    "select principal_id from users where github_user_id = $1",
    [githubUserId],
  );
  return { cookie, principalId: rows[0]!.principal_id };
}

/** The `reviewers` Group of a project, with the given principals as members. `ownerPrincipalId` is the break-glass caller, who self-adds as admin and must not be re-added as a mere member. */
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
      // A Group can only contain members of its own Project.
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

/** Seeds an interactive StepRun, creates its `reviewers` Group, claims it, uploads a session, and POSTs a Question. */
async function claimAndAsk(
  rig: TestRig,
  ownerCookie: string,
  ownerPrincipalId: string,
  runner: JoinedRunner,
  reviewerPrincipalIds: string[],
  definition = APPROVAL_DEFINITION,
  sessionId = "sess-abc",
): Promise<{ questionId: string; groupId: string; stepRun: { id: string; lease_token: string; turn: number }; runId: string }> {
  const seeded = await seedReadyStepRun(
    rig.pool,
    { stepKey: "review" },
    undefined,
    { definition, definitionFiles: { "prompts/review.md": PROMPT_TEXT } },
  );
  const groupId = await createReviewerGroup(rig, ownerCookie, ownerPrincipalId, seeded.projectId, reviewerPrincipalIds);

  const claimed = await runner.client.claim(runner.secret);
  const stepRun = (claimed.body as { step_run: { id: string; lease_token: string; turn: number } }).step_run;
  expect(stepRun.id).toBe(seeded.stepRunId);

  // push branch → upload session → POST Question (spec's commit order).
  const sessionJsonl = '{"type":"turn-1"}\n';
  const grants = await runner.client.uploads(runner.secret, stepRun.id, {
    lease_token: stepRun.lease_token,
    requests: [{ key: `${sessionId}.jsonl`, kind: "session" }],
  });
  const grant = (grants.body as { grants: { key: string; upload_url: string; blob_key: string }[] }).grants[0]!;
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
    session_id: sessionId,
  });
  expect(asked.status).toBe(200);
  return { questionId: (asked.body as { question_id: string }).question_id, groupId, stepRun, runId: seeded.runId };
}

async function answer(rig: TestRig, cookie: string, questionId: string, answerBody: unknown): Promise<Response> {
  return rig.fetchWithCsrf(`${rig.baseUrl}/questions/${questionId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ answer: answerBody }),
  });
}

/** Claims and ends the next `ready` row for this runner — consumed so a born turn-2 row never leaks into the next test (the rig's Postgres container is shared across the describe block). */
async function settleNextTurn(runner: JoinedRunner): Promise<void> {
  const claimed = await runner.client.claim(runner.secret);
  const next = (claimed.body as { step_run: { id: string; lease_token: string } | null }).step_run;
  if (!next) return;
  await runner.client.result(runner.secret, next.id, {
    lease_token: next.lease_token,
    outcome: "succeeded",
    ref: { branch: `run/${next.id}/review/t2-a1`, sha: "cafebabe" },
    output_data: { kind: "done", outputs: {} },
  });
}

describe("Step human-in-the-loop (issue 13)", () => {
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

  it("AC1 — awaiting-human releases the lease and slot: the Runner drains while the conversation hangs, and the next turn is claimed by a different machine", async () => {
    const runnerA = await joinRunner(rig, ownerCookie);
    const { questionId, stepRun } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runnerA, [ownerPrincipalId]);

    // awaiting-human is a DB row without a lease: no lessee, no expiry, and
    // the Runner's slot is not held by anything.
    const row = await rig.pool.query<{ outcome: string; leased_by: string | null; lease_expires_at: string | null }>(
      "select outcome, leased_by, lease_expires_at from step_runs where id = $1",
      [stepRun.id],
    );
    expect(row.rows[0]).toEqual({ outcome: "awaiting-human", leased_by: null, lease_expires_at: null });

    // The Runner can drain while the conversation hangs — there is nothing to
    // finish. (selfDrain is the CLI-local write of desired_state; the drain
    // completes immediately because no lease is held.)
    const drain = await runnerA.client.selfDrain(runnerA.secret);
    expect(drain.status).toBe(200);

    // The human answers through the web.
    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: true })).status).toBe(200);

    // A *different* machine claims the next turn — the conversation resumes
    // on whatever Runner is free (AC1), with the session and the previous
    // turn's ref in the payload.
    const runnerB = await joinRunner(rig, ownerCookie);
    const nextClaim = await runnerB.client.claim(runnerB.secret);
    const next = (nextClaim.body as {
      step_run: {
        id: string;
        turn: number;
        attempt: number;
        ref: { branch: string; sha: string };
        session: { id: string; blob_key: string; get_url: string } | null;
        ask_group_id: string | null;
      } | null;
    }).step_run;
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(stepRun.id);
    expect(next!.turn).toBe(2);
    expect(next!.attempt).toBe(1);
    expect(next!.ref).toEqual({ branch: `run/${stepRun.id}/review/t1-a1`, sha: "cafebabe" });
    expect(next!.session).toMatchObject({ id: "sess-abc", blob_key: `session/${stepRun.id}/sess-abc.jsonl` });
  });

  it("AC2 — the session travels via the blob store: a session PUT is minted and its bytes recorded before the Question, and the resumed turn's claim carries a presigned GET", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    // The control plane minted a PUT for session/{stepRunId}/{sessionId}.jsonl
    // and the bytes actually landed in the fake store (peer-to-peer).
    expect(rig.objectStore.mintedPuts).toContain(`session/${stepRun.id}/sess-abc.jsonl`);
    expect(rig.objectStore.objects.get(`session/${stepRun.id}/sess-abc.jsonl`)).toBe('{"type":"turn-1"}\n');

    // After the human answers, the resumed turn's claim mints a presigned GET
    // for the very same blob — the Runner fetches the conversation back.
    const questionId = (await rig.pool.query<{ id: string }>(
      "select id from questions where step_run_id = $1 and answered_at is null",
      [stepRun.id],
    )).rows[0]!.id;
    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: true })).status).toBe(200);
    const resumed = await runner.client.claim(runner.secret);
    const next = (resumed.body as { step_run: { id: string; session: { get_url: string; blob_key: string } | null } | null }).step_run;
    expect(next).not.toBeNull();
    expect(rig.objectStore.mintedGets).toContain(`session/${stepRun.id}/sess-abc.jsonl`);
    expect(next!.session).not.toBeNull();
  });

  it("AC3 — two separate numberings: an answer births a new StepRun row at turn + 1, attempt 1; the answered row ends its turn as succeeded", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun, questionId, runId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: true })).status).toBe(200);

    const { rows } = await rig.pool.query<{ id: string; turn: number; attempt: number; outcome: string }>(
      "select id, turn, attempt, outcome from step_runs where run_id = $1 order by turn asc",
      [runId],
    );
    expect(rows).toHaveLength(2);
    // The answered turn ends (succeeded); a new row is born with attempt
    // reset to 1 — the retry policy reads `attempt` only, per-row.
    expect(rows[0]).toMatchObject({ id: stepRun.id, turn: 1, attempt: 1, outcome: "succeeded" });
    expect(rows[1]).toMatchObject({ turn: 2, attempt: 1, outcome: "ready" });
    await settleNextTurn(runner);
  });

  it("AC5 — approved:false is data: with onReject: continue (the default) the rejection becomes the next turn's resume prompt", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun, questionId, runId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: false, reason: "not ready" })).status).toBe(200);

    // Nothing failed: a new turn was born, and its resume prompt carries the
    // rejection so the agent continues from the same conversation.
    const next = await rig.pool.query<{ id: string; turn: number; resume_prompt: string | null; outcome: string }>(
      "select id, turn, resume_prompt, outcome from step_runs where run_id = $1 order by turn desc limit 1",
      [runId],
    );
    expect(next.rows[0]).toMatchObject({ turn: 2, outcome: "ready" });
    expect(next.rows[0]!.resume_prompt).toContain("rejected");
    expect(next.rows[0]!.resume_prompt).toContain("not ready");

    // When the next turn is claimed, the final prompt is the Step's own
    // prompt + format block + the human's answer (AC5: "dikirim balik ke agent
    // sebagai prompt giliran berikutnya").
    const resumed = await runner.client.claim(runner.secret);
    expect((resumed.body as { step_run: { id: string } | null }).step_run?.id).toBe(next.rows[0]!.id);
    const pinned = await rig.pool.query<{ final_prompt: string | null }>(
      "select final_prompt from step_runs where id = $1",
      [next.rows[0]!.id],
    );
    expect(pinned.rows[0]!.final_prompt).toContain("Review the work.");
    expect(pinned.rows[0]!.final_prompt).toContain("rejected");
    expect(pinned.rows[0]!.final_prompt).toContain("not ready");
    void stepRun;
  });

  it("AC5 — onReject: fail ends the StepRun (and the Run) on a rejection, without ever failing the answer write", async () => {
    const failDefinition = APPROVAL_DEFINITION.replace("kind: approval", "kind: approval\n    onReject: fail");
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun, questionId, runId } = await claimAndAsk(
      rig,
      ownerCookie,
      ownerPrincipalId,
      runner,
      [ownerPrincipalId],
      failDefinition,
    );

    // The rejection is still just data flowing through the answer write (200)…
    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: false, reason: "nope" })).status).toBe(200);

    // …but this Step declares onReject: fail, so the StepRun fails and the
    // Run ends. No new turn is born.
    const row = await rig.pool.query<{ outcome: string; reason: string | null }>(
      "select outcome, reason from step_runs where id = $1",
      [stepRun.id],
    );
    expect(row.rows[0]).toEqual({ outcome: "failed", reason: "rejected-by-human" });
    const next = await rig.pool.query<{ id: string }>(
      "select id from step_runs where run_id = (select run_id from step_runs where id = $1) and turn > 1",
      [stepRun.id],
    );
    expect(next.rows).toHaveLength(0);
    const run = await rig.pool.query<{ outcome: string | null }>(
      "select outcome from runs where id = (select run_id from step_runs where id = $1)",
      [stepRun.id],
    );
    expect(run.rows[0]!.outcome).toBe("failed");
    const failedNotification = await rig.pool.query<{ kind: string; run_id: string }>(
      "select kind, run_id from pending_notifications where run_id = $1",
      [runId],
    );
    expect(failedNotification.rows).toContainEqual({ kind: "run-failed", run_id: runId });
  });

  it("AC6 — the Question addresses a Group; the answer records the answering principal; a non-member is refused", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { questionId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    // A real user who is not in the Group gets 403.
    const { cookie: outsiderCookie } = await githubLogin(rig, 6101);
    expect((await answer(rig, outsiderCookie, questionId, { kind: "approval", approved: true })).status).toBe(403);

    // The group member answers; the answering principal is recorded.
    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: true, reason: "ok" })).status).toBe(200);
    const q = await rig.pool.query<{ answered_by_principal_id: string; answer: unknown }>(
      "select answered_by_principal_id, answer from questions where id = $1",
      [questionId],
    );
    expect(q.rows[0]!.answered_by_principal_id).toBe(ownerPrincipalId);
    expect(q.rows[0]!.answer).toEqual({ kind: "approval", approved: true, reason: "ok" });
    await settleNextTurn(runner);
  });

  it("AC7 — the partial unique index enforces one open Question per StepRun", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    // A second open Question for the same StepRun is refused by the index.
    await expect(
      rig.pool.query(
        "insert into questions (id, step_run_id, kind, body, group_id, created_at) values ($1, $2, 'text', 'another?', $3, now())",
        [generateId("question"), stepRun.id, (await rig.pool.query<{ group_id: string }>(
          "select group_id from questions where step_run_id = $1 limit 1",
          [stepRun.id],
        )).rows[0]!.group_id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("AC8 — losing the answering race is state, not error: 409 carries the latest Question, the winner's identity, and the loser's own typed text", async () => {
    const secondUser = await githubLogin(rig, 6102);
    const runner = await joinRunner(rig, ownerCookie);
    const { questionId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId, secondUser.principalId]);

    // The first answer wins.
    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: true, reason: "first" })).status).toBe(200);

    // The second answerer loses the compare-and-set — 409 with the latest
    // state and their own text preserved.
    const second = await answer(rig, secondUser.cookie, questionId, { kind: "approval", approved: false, reason: "second's typed reason" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      code: string;
      question: { answeredByPrincipalId: string | null; answer: unknown; stepRunOutcome: string };
      typedAnswer: unknown;
    };
    expect(body.code).toBe("question_race_lost");
    expect(body.question.answeredByPrincipalId).toBe(ownerPrincipalId);
    expect(body.question.answer).toEqual({ kind: "approval", approved: true, reason: "first" });
    expect(body.typedAnswer).toEqual({ kind: "approval", approved: false, reason: "second's typed reason" });
    await settleNextTurn(runner);
  });

  it("AC9 — the waiting list only shows open Questions on awaiting-human StepRuns, and answers clear them", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { questionId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    const waiting = await fetch(`${rig.baseUrl}/questions/waiting`, { headers: { cookie: ownerCookie } });
    expect(waiting.status).toBe(200);
    const list = (await waiting.json()) as { questions: { id: string; stepRunOutcome: string }[] };
    expect(list.questions.map((q) => q.id)).toContain(questionId);
    expect(list.questions[0]!.stepRunOutcome).toBe("awaiting-human");

    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: true })).status).toBe(200);
    const after = await fetch(`${rig.baseUrl}/questions/waiting`, { headers: { cookie: ownerCookie } });
    const afterList = (await after.json()) as { questions: { id: string }[] };
    expect(afterList.questions.map((q) => q.id)).not.toContain(questionId);
    await settleNextTurn(runner);
  });

  it("AC10 — cancel while awaiting-human is a pure DB row write: the operator cancel endpoint, no Runner endpoint involved", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { questionId, stepRun } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    const cancelled = await rig.fetchWithCsrf(`${rig.baseUrl}/step-runs/${stepRun.id}/cancel`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(cancelled.status).toBe(200);

    const row = await rig.pool.query<{ outcome: string; reason: string | null }>(
      "select outcome, reason from step_runs where id = $1",
      [stepRun.id],
    );
    expect(row.rows[0]).toEqual({ outcome: "cancelled", reason: "cancelled-by-operator" });

    // The open Question is no longer answerable — the waiting list is a query
    // over awaiting-human StepRuns, so the cancelled run's Question vanishes.
    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: true })).status).toBe(409);
  });

  it("the web surface reads one Question's state (the read-after-race refresh path)", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { questionId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    const got = await fetch(`${rig.baseUrl}/questions/${questionId}`, { headers: { cookie: ownerCookie } });
    expect(got.status).toBe(200);
    const body = (await got.json()) as { id: string; kind: string; body: string };
    expect(body).toMatchObject({ id: questionId, kind: "approval", body: "Approve this plan?" });
  });

  it("the resumed turn's base ref is the previous turn's pushed branch, not the Run's original ref", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const { stepRun, questionId } = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);

    expect((await answer(rig, ownerCookie, questionId, { kind: "approval", approved: true })).status).toBe(200);
    const resumed = await runner.client.claim(runner.secret);
    const next = (resumed.body as { step_run: { ref: { branch: string; sha: string } } | null }).step_run;
    expect(next!.ref).toEqual({ branch: `run/${stepRun.id}/review/t1-a1`, sha: "cafebabe" });
  });

  it("orders the waiting page oldest first", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const oldest = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);
    const newest = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);
    await rig.pool.query(
      "update questions set created_at = case id when $1 then $3::timestamptz when $2 then $4::timestamptz end where id in ($1, $2)",
      [oldest.questionId, newest.questionId, "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z"],
    );

    const response = await fetch(`${rig.baseUrl}/questions/waiting`, { headers: { cookie: ownerCookie } });
    const body = (await response.json()) as { questions: { id: string; createdAt: string }[] };
    const ids = body.questions.map((question) => question.id);
    expect(ids.indexOf(oldest.questionId)).toBeLessThan(ids.indexOf(newest.questionId));
    expect(body.questions.find((question) => question.id === oldest.questionId)?.createdAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("carries the state-derived badge count on Graph and log responses", async () => {
    const runner = await joinRunner(rig, ownerCookie);
    const empty = await seedReadyStepRun(rig.pool);
    await rig.pool.query("update step_runs set outcome = 'succeeded' where id = $1", [empty.stepRunId]);
    await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${empty.projectId}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    const beforeResponse = await fetch(`${rig.baseUrl}/projects/${empty.projectId}/runs`, {
      headers: { cookie: ownerCookie },
    });
    const before = (await beforeResponse.json()) as { waitingQuestionCount: number };

    const asked = await claimAndAsk(rig, ownerCookie, ownerPrincipalId, runner, [ownerPrincipalId]);
    const project = await rig.pool.query<{ project_id: string }>("select project_id from runs where id = $1", [asked.runId]);
    const graphResponse = await fetch(`${rig.baseUrl}/projects/${project.rows[0]!.project_id}/runs`, {
      headers: { cookie: ownerCookie },
    });
    const graph = (await graphResponse.json()) as { waitingQuestionCount: number };
    expect(graph.waitingQuestionCount).toBe(before.waitingQuestionCount + 1);

    const logResponse = await fetch(`${rig.baseUrl}/step-runs/${asked.stepRun.id}/log?offset=0`, {
      headers: { cookie: ownerCookie },
    });
    const log = (await logResponse.json()) as { waitingQuestionCount: number };
    expect(log.waitingQuestionCount).toBe(graph.waitingQuestionCount);
  });
});
