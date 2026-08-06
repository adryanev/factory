import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
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
 * penanda pemetaan akhir: `NULL` = belum selesai (baik belum dicoba maupun
 * masih menunggu retry berikutnya), non-`NULL` = selesai — sukses, atau
 * dead-letter setelah lima percobaan gagal berturut-turut. `attempts`
 * menghitung percobaan gagal; `nextAttemptAt` adalah waktu paling awal baris
 * ini boleh terpilih lagi sweep berikutnya. `ingestWebhook` menulisnya
 * eksplisit dari `deps.clock` saat insert, bukan mengandalkan default `now()`
 * kolom ini (yang tetap ada sebagai jaring pengaman untuk insert SQL
 * langsung dan backfill migrasi) — sweep membandingkan `nextAttemptAt`
 * terhadap `deps.clock` yang sama, dan kedua sisi harus sejam supaya baris
 * yang baru masuk langsung layak dipilih. Sweep membaca `now()` sekali di
 * awal putaran dan memakainya sebagai batas atas `nextAttemptAt` — itulah
 * yang membuat loop pemrosesannya berhenti: baris yang dijadwal ulang ke
 * masa depan tidak bisa terpilih lagi di putaran yang sama, jadi baris yang
 * selalu gagal tidak pernah menggantung sweep-nya.
 *
 * `purgedAt` memakai pola penanda retensi yang sama dengan keempat sweep
 * lainnya (spec: "Sweep `webhook_deliveries` 24 jam memakai pola penanda
 * yang sama"): nullable, dengan partial index `(received_at) WHERE purged_at
 * IS NULL`, sehingga sweep-nya indexed scan yang menyusut sambil bekerja dan
 * idempoten. Baris ini tidak menunjuk blob apa pun — satu-satunya kerja sweep
 * retensi adalah menulis penandanya (db/sql/retention_sweeps.sql); baris itu
 * sendiri tidak pernah dihapus, terlepas dari `processedAt` atau `attempts`.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (table) => [
    index("webhook_deliveries_received_at_idx").on(table.receivedAt),
    index("webhook_deliveries_retention_idx")
      .on(table.receivedAt)
      .where(sql`${table.purgedAt} is null`),
    index("webhook_deliveries_pending_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.processedAt} is null`),
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
