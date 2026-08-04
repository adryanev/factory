import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { projects } from "./projects.js";
import { runs } from "./runs.js";

/** Outgoing channel events. There is deliberately no User target here. */
export const notificationKinds = ["question-issued", "run-failed", "daily-digest"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/**
 * Durable work for the single Project webhook. Event rows are removed after a
 * successful delivery; digest rows remain until their short retention window
 * expires so a sweep retry cannot send the same day's digest twice.
 */
export const pendingNotifications = pgTable(
  "pending_notifications",
  {
    /** Also carries the coalescing and daily-digest idempotency key. */
    dedupeKey: text("dedupe_key").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id)
      .$type<Id<"project">>(),
    runId: text("run_id")
      .references(() => runs.id)
      .$type<Id<"run"> | null>(),
    kind: text("kind").notNull().$type<NotificationKind>(),
    sendAfter: timestamp("send_after", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "pending_notifications_kind_check",
      sql`${table.kind} in ('question-issued', 'run-failed', 'daily-digest')`,
    ),
    index("pending_notifications_due_idx")
      .on(table.sendAfter)
      .where(sql`${table.sentAt} is null`),
    index("pending_notifications_project_idx").on(table.projectId),
  ],
);
