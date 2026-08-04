import { and, asc, eq, isNotNull, isNull, lte, lt, sql } from "drizzle-orm";
import type { Id } from "@factory/shared";
import type { Database } from "../db/client.js";
import { pendingNotifications, projects, questions, runs, stepRuns } from "../db/schema.js";
import type { Clock, NotificationSender } from "../deps.js";

export const NOTIFICATION_COALESCE_WINDOW_MS = 60_000;
const DIGEST_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

function questionNotificationKey(runId: Id<"run">): string {
  return `question-issued:${runId}`;
}

function runFailureNotificationKey(runId: Id<"run">): string {
  return `run-failed:${runId}`;
}

function digestNotificationKey(projectId: Id<"project">, now: Date): string {
  return `daily-digest:${projectId}:${now.toISOString().slice(0, 10)}`;
}

/** Queues one channel-level Question event for a Run; duplicate branches coalesce at this key. */
export async function queueQuestionNotification(
  db: Database,
  projectId: Id<"project">,
  runId: Id<"run">,
  now: Date,
): Promise<void> {
  await db
    .insert(pendingNotifications)
    .values({
      dedupeKey: questionNotificationKey(runId),
      projectId,
      runId,
      kind: "question-issued",
      sendAfter: new Date(now.getTime() + NOTIFICATION_COALESCE_WINDOW_MS),
      createdAt: now,
    })
    .onConflictDoNothing();
}

/** Queues one channel-level failure event. A Run can only receive one final verdict. */
export async function queueRunFailedNotification(
  db: Database,
  projectId: Id<"project">,
  runId: Id<"run">,
  now: Date,
): Promise<void> {
  await db
    .insert(pendingNotifications)
    .values({
      dedupeKey: runFailureNotificationKey(runId),
      projectId,
      runId,
      kind: "run-failed",
      sendAfter: new Date(now.getTime() + NOTIFICATION_COALESCE_WINDOW_MS),
      createdAt: now,
    })
    .onConflictDoNothing();
}

async function queueDailyDigests(db: Database, now: Date): Promise<void> {
  const olderThan = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ projectId: projects.id })
    .from(questions)
    .innerJoin(stepRuns, eq(stepRuns.id, questions.stepRunId))
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(
      and(
        isNull(questions.answeredAt),
        eq(stepRuns.outcome, "awaiting-human"),
        lte(questions.createdAt, olderThan),
        isNotNull(projects.notificationWebhookUrl),
      ),
    )
    .groupBy(projects.id);

  for (const row of rows) {
    await db
      .insert(pendingNotifications)
      .values({
        dedupeKey: digestNotificationKey(row.projectId, now),
        projectId: row.projectId,
        kind: "daily-digest",
        sendAfter: now,
        createdAt: now,
      })
      .onConflictDoNothing();
  }
}

interface NotificationSweepDeps {
  db: Database;
  clock: Clock;
  notificationSender: NotificationSender;
}

interface PendingNotificationRow {
  pending: typeof pendingNotifications.$inferSelect;
  project: typeof projects.$inferSelect;
}

async function loadPendingNotification(
  db: Database,
  now: Date,
): Promise<PendingNotificationRow | undefined> {
  const [row] = await db
    .select({ pending: pendingNotifications, project: projects })
    .from(pendingNotifications)
    .innerJoin(projects, eq(projects.id, pendingNotifications.projectId))
    .where(and(lte(pendingNotifications.sendAfter, now), isNull(pendingNotifications.sentAt)))
    .orderBy(asc(pendingNotifications.sendAfter))
    .limit(1)
    .for("update", { skipLocked: true });
  return row;
}

async function questionText(db: Database, runId: Id<"run">): Promise<string> {
  const [summary] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(questions)
    .innerJoin(stepRuns, eq(stepRuns.id, questions.stepRunId))
    .where(
      and(
        eq(stepRuns.runId, runId),
        isNull(questions.answeredAt),
        eq(stepRuns.outcome, "awaiting-human"),
      ),
    );
  const count = summary?.count ?? 0;
  return count > 0
    ? `Run ${runId}: ${count} question${count === 1 ? "" : "s"} waiting for the Project channel.`
    : `Run ${runId}: a question was issued for the Project channel.`;
}

async function digestText(
  db: Database,
  projectId: Id<"project">,
  now: Date,
): Promise<string | null> {
  const [summary] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${questions.createdAt})`,
    })
    .from(questions)
    .innerJoin(stepRuns, eq(stepRuns.id, questions.stepRunId))
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(
      and(
        eq(runs.projectId, projectId),
        isNull(questions.answeredAt),
        eq(stepRuns.outcome, "awaiting-human"),
        lte(questions.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      ),
    );
  const count = summary?.count ?? 0;
  if (count === 0) return null;
  return `Project ${projectId}: ${count} question${count === 1 ? "" : "s"} waiting for more than 24 hours.`;
}

async function deliverOne(deps: NotificationSweepDeps, now: Date): Promise<boolean> {
  try {
    return await deps.db.transaction(async (tx) => {
      const row = await loadPendingNotification(tx, now);
      if (!row) return false;

      const { pending, project } = row;
      if (project.notificationWebhookUrl === null) {
        await tx.delete(pendingNotifications).where(eq(pendingNotifications.dedupeKey, pending.dedupeKey));
        return true;
      }

      let text: string | null;
      switch (pending.kind) {
        case "question-issued":
          text = pending.runId ? await questionText(tx, pending.runId) : "A Question was issued for the Project channel.";
          break;
        case "run-failed":
          text = pending.runId
            ? `Run ${pending.runId} failed.`
            : `A Run failed in Project ${pending.projectId}.`;
          break;
        case "daily-digest":
          text = await digestText(tx, pending.projectId, now);
          break;
      }

      if (text !== null) {
        // The URL is deliberately used only at this internal delivery seam.
        // It never enters an API response, audit metadata, or an error message.
        await deps.notificationSender.send(project.notificationWebhookUrl, { text });
      } else {
        // The digest was queued from state that has since cleared. Let a later
        // state change create a new same-day digest key instead of recording a
        // false delivery.
        await tx.delete(pendingNotifications).where(eq(pendingNotifications.dedupeKey, pending.dedupeKey));
        return true;
      }

      if (pending.kind === "daily-digest") {
        await tx
          .update(pendingNotifications)
          .set({ sentAt: now })
          .where(eq(pendingNotifications.dedupeKey, pending.dedupeKey));
      } else {
        await tx.delete(pendingNotifications).where(eq(pendingNotifications.dedupeKey, pending.dedupeKey));
      }
      return true;
    });
  } catch {
    // Keep the row pending for a later sweep. Do not log the URL or payload:
    // incoming-webhook URLs are bearer secrets.
    console.error("notification delivery failed");
    return false;
  }
}

/**
 * Runs from the existing sweep cadence. The sweep owns delivery timing; there
 * is no notification-specific poller. Digest eligibility is read from current
 * Question state and its UTC-day key makes a retry idempotent.
 */
export async function sweepPendingNotifications(deps: NotificationSweepDeps): Promise<number> {
  const now = deps.clock.now();
  await queueDailyDigests(deps.db, now);

  await deps.db
    .delete(pendingNotifications)
    .where(
      and(
        eq(pendingNotifications.kind, "daily-digest"),
        isNotNull(pendingNotifications.sentAt),
        lt(pendingNotifications.sentAt, new Date(now.getTime() - DIGEST_RETENTION_MS)),
      ),
    );

  let delivered = 0;
  for (;;) {
    const didWork = await deliverOne(deps, now);
    if (!didWork) break;
    delivered += 1;
  }
  return delivered;
}
