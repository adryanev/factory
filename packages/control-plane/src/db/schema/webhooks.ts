import { index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { repositories } from "./repositories.js";

/**
 * Dedup lapis pertama: `X-GitHub-Delivery` selama 24 jam (spec: "Automation").
 * `deliveryId` adalah id GitHub sendiri (bukan id yang kita bangkitkan), jadi
 * primary key polos sudah cukup sebagai dedup — tidak perlu partial unique
 * index di sini (issue 25-database-schema.md, bagian "Dedup").
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhook_deliveries_received_at_idx").on(table.receivedAt)],
);

/**
 * Cache definisi Pipeline — wajib (bukan optimasi murni) karena pemetaan
 * webhook→Pipeline butuh tahu Pipeline apa yang ada tanpa menembak GitHub
 * tiap kejadian, tapi tetap boleh dihapus kapan saja karena jalur pengisian
 * sinkron saat miss selalu ada (spec: "Automation"). Diperbarui di latar
 * saat push ke default branch; TIDAK PERNAH dibaca jalur eksekusi — eksekusi
 * membaca snapshot di `runs.definition`.
 */
export const pipelineDefinitionCache = pgTable(
  "pipeline_definition_cache",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id)
      .$type<Id<"repository">>(),
    path: text("path").notNull(),
    ref: text("ref").notNull(),
    contentSha: text("content_sha").notNull(),
    parsed: jsonb("parsed").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.repositoryId, table.path] })],
);
