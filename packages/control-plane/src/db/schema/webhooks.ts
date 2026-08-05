import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { repositories } from "./repositories.js";

/**
 * Dedup lapis pertama + antrean event mentah: `X-GitHub-Delivery` sebagai
 * primary key (spec: "Automation"). `deliveryId` adalah id GitHub sendiri
 * (bukan id yang kita bangkitkan), jadi primary key polos sudah cukup sebagai
 * dedup — tidak perlu partial unique index di sini (issue
 * 25-database-schema.md, bagian "Dedup").
 *
 * Endpoint webhook memverifikasi HMAC lalu menaruh event mentah di sini dan
 * menjawab 2xx; seluruh pekerjaan pemetaan terjadi di sweep, di luar jalur
 * request GitHub (ticket 22: "menaruh event mentah di tabel dan menjawab
 * 2xx. Seluruh pekerjaan pemetaan terjadi setelah itu"). `processedAt` adalah
 * penanda pemetaan: `NULL` = belum dipetakan, diambil sweep dari yang paling
 * tua. Kegagalan pemetaan membiarkan baris tetap `NULL` sehingga pengiriman
 * berikutnya mencoba lagi; baris yang lebih tua dari jendela 24 jam dipangkas
 * apa pun statusnya, jadi retry punya batas natural (dan GitHub sendiri punya
 * tombol redelivery untuk yang hilang).
 *
 * `purgedAt` memakai pola penanda retensi yang sama dengan keempat sweep
 * lainnya (spec: "Sweep `webhook_deliveries` 24 jam memakai pola penanda
 * yang sama"): nullable, dengan partial index `(received_at) WHERE purged_at
 * IS NULL`, sehingga sweep-nya indexed scan yang menyusut sambil bekerja dan
 * idempoten. Baris ini tidak menunjuk blob apa pun — satu-satunya kerja
 * sweep adalah menulis penandanya (db/sql/retention_sweeps.sql).
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (table) => [
    index("webhook_deliveries_received_at_idx").on(table.receivedAt),
    index("webhook_deliveries_retention_idx")
      .on(table.receivedAt)
      .where(sql`${table.purgedAt} is null`),
  ],
);

/**
 * Cache definisi Pipeline — wajib (bukan optimasi murni) karena pemetaan
 * webhook→Pipeline butuh tahu Pipeline apa yang ada tanpa menembak GitHub
 * tiap kejadian, tapi tetap boleh dihapus kapan saja karena jalur pengisian
 * sinkron saat miss selalu ada (spec: "Automation"). Ini **indeks penemuan**
 * (repository, path) mana yang Pipeline; `parsed` disimpan agar isi cache
 * bisa diperiksa, tapi TIDAK PERNAH dibaca jalur eksekusi — eksekusi membaca
 * definisi segar dari ref yang dipicu dan menyimpan snapshot di
 * `runs.definition`. `ref`/`contentSha` mencatat dari mana baris ini diisi,
 * sehingga panggilan yang butuh definisi segar bisa tahu kapan baris usang.
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
