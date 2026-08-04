import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId, type Id } from "@factory/shared";
import {
  queueQuestionNotification,
  queueRunFailedNotification,
  sweepPendingNotifications,
} from "../../src/domain/notifications.js";
import { startTestRig, type TestRig } from "./setup.js";
import { realIdGenerator, seedReadyStepRun, type IdGenerator } from "./runner-test-helpers.js";
import { seedStepRun } from "../sql/seed.js";

async function configureWebhook(rig: TestRig, cookie: string, projectId: string, url: string): Promise<void> {
  await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/members/self`, {
    method: "POST",
    headers: { cookie },
  });
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ notificationWebhookUrl: url }),
  });
  expect(response.status).toBe(200);
}

async function createWaitingQuestion(
  rig: TestRig,
  fixture: Awaited<ReturnType<typeof seedReadyStepRun>>,
  ids: IdGenerator,
  createdAt: string,
): Promise<void> {
  const groupId = generateId("group");
  await rig.pool.query("insert into groups (id, project_id, name) values ($1, $2, $3)", [
    groupId,
    fixture.projectId,
    `reviewers-${groupId}`,
  ]);
  const stepRunId = await seedStepRun(rig.pool, ids, {
    runId: fixture.runId as Id<"run">,
    repositoryId: fixture.repositoryId as Id<"repository">,
    stepKey: "review",
    branchKey: `branch-${groupId}`,
    outcome: "awaiting-human",
  });
  await rig.pool.query(
    "insert into questions (id, step_run_id, kind, body, group_id, created_at) values ($1, $2, 'text', 'review', $3, $4)",
    [generateId("question"), stepRunId, groupId, createdAt],
  );
}

describe("Project notification delivery", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("migrates the channel queue and keeps the badge index partial", async () => {
    const indexes = await rig.pool.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where tablename in ('questions', 'pending_notifications') order by indexname",
    );
    const waitingIndex = indexes.rows.find((row) => row.indexname === "questions_waiting_for_me_idx");
    expect(waitingIndex?.indexdef).toContain("(created_at)");
    expect(waitingIndex?.indexdef).toContain("answered_at");
    expect(indexes.rows.map((row) => row.indexname)).toContain("pending_notifications_due_idx");
  });

  it("coalesces fan-out Question events into one Project-channel message", async () => {
    const fixture = await seedReadyStepRun(rig.pool);
    await configureWebhook(rig, ownerCookie, fixture.projectId, "https://hooks.example.test/factory-secret");
    const groupId = generateId("group");
    await rig.pool.query("insert into groups (id, project_id, name) values ($1, $2, $3)", [
      groupId,
      fixture.projectId,
      "reviewers",
    ]);
    const ids = realIdGenerator();
    for (let branch = 0; branch < 50; branch += 1) {
      const stepRunId = await seedStepRun(rig.pool, ids, {
        runId: fixture.runId as Id<"run">,
        repositoryId: fixture.repositoryId as Id<"repository">,
        stepKey: "review",
        branchKey: `branch-${branch}`,
        outcome: "awaiting-human",
      });
      await rig.pool.query(
        "insert into questions (id, step_run_id, kind, body, group_id) values ($1, $2, 'text', 'review', $3)",
        [generateId("question"), stepRunId, groupId],
      );
    }

    const now = new Date("2026-01-01T00:00:00.000Z");
    for (let branch = 0; branch < 50; branch += 1) {
      await queueQuestionNotification(
        rig.deps.db,
        fixture.projectId as Id<"project">,
        fixture.runId as Id<"run">,
        now,
      );
    }
    const pending = await rig.pool.query<{ count: string }>(
      "select count(*)::text as count from pending_notifications where kind = 'question-issued' and run_id = $1",
      [fixture.runId],
    );
    expect(pending.rows[0]!.count).toBe("1");

    rig.setClock(new Date("2026-01-01T00:01:00.000Z"));
    await sweepPendingNotifications(rig.deps);
    expect(rig.notifications.sent).toHaveLength(1);
    expect(rig.notifications.sent[0]).toMatchObject({ url: "https://hooks.example.test/factory-secret" });
    expect(rig.notifications.sent[0]!.text).toContain("50 questions");
  });

  it("sends one state-derived daily digest and does not repeat it on a same-day sweep", async () => {
    const fixture = await seedReadyStepRun(rig.pool);
    await configureWebhook(rig, ownerCookie, fixture.projectId, "https://hooks.example.test/digest-secret");
    await createWaitingQuestion(
      rig,
      fixture,
      realIdGenerator(),
      "2025-12-31T00:00:00.000Z",
    );

    rig.setClock(new Date("2026-01-02T00:00:00.000Z"));
    const first = await sweepPendingNotifications(rig.deps);
    const sentAfterFirst = rig.notifications.sent.length;
    const second = await sweepPendingNotifications(rig.deps);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(rig.notifications.sent.length).toBe(sentAfterFirst);
    expect(rig.notifications.sent.at(-1)?.text).toContain("more than 24 hours");
  });

  it("delivers the second event type for a failed Run", async () => {
    const fixture = await seedReadyStepRun(rig.pool);
    await configureWebhook(rig, ownerCookie, fixture.projectId, "https://hooks.example.test/failure-secret");
    const now = new Date("2026-01-03T00:00:00.000Z");
    await queueRunFailedNotification(
      rig.deps.db,
      fixture.projectId as Id<"project">,
      fixture.runId as Id<"run">,
      now,
    );
    rig.setClock(new Date("2026-01-03T00:01:00.000Z"));
    const sentBeforeSweep = rig.notifications.sent.length;
    await sweepPendingNotifications(rig.deps);
    expect(rig.notifications.sent.slice(sentBeforeSweep)).toContainEqual({
      url: "https://hooks.example.test/failure-secret",
      text: `Run ${fixture.runId} failed.`,
    });
  });
});
