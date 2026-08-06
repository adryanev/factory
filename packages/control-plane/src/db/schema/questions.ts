import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { Answer, Id, QuestionOption } from "@factory/shared";
import { groups } from "./projects.js";
import { users } from "./principals.js";
import { stepRuns } from "./step_runs.js";

/**
 * Permintaan jawaban dari manusia, diterbitkan oleh Interactive Step dan
 * disimpan di control plane; tetap ada meskipun Runner mati atau browser
 * ditutup (CONTEXT.md). `kind` tertutup — empat nilai, sudah tumbuh sekali
 * (`edit-artifact` ditambahkan belakangan), maka `text` + CHECK bukan
 * `pgEnum` (spec: "Skema database").
 *
 * `options`/`multi`/`allowOther` hanya berarti untuk `kind: 'choice'`, dan
 * `artifactKey` hanya untuk `kind: 'edit-artifact'` — tidak dijadikan CHECK
 * silang per-kind di sini karena bentuk Question/Answer sudah ditegakkan
 * skema Zod di `shared` sebagai gerbang otoritatif (spec: "Step yang
 * menunggu manusia").
 */
export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey().$type<Id<"question">>(),
    stepRunId: text("step_run_id")
      .notNull()
      .references(() => stepRuns.id)
      .$type<Id<"steprun">>(),
    kind: text("kind").notNull().$type<"text" | "choice" | "approval" | "edit-artifact">(),
    body: text("body").notNull(),
    options: jsonb("options").$type<QuestionOption[] | null>(),
    multi: boolean("multi").$type<boolean | null>(),
    allowOther: boolean("allow_other").$type<boolean | null>(),
    artifactKey: text("artifact_key").$type<string | null>(),
    // Question ditujukan ke Group (audiens), bukan individu (spec: "Step
    // yang menunggu manusia").
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id)
      .$type<Id<"group">>(),
    // Predikat "Menunggu saya" diurutkan umur — lihat partial index di bawah
    // (spec: "Skema database").
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredByPrincipalId: text("answered_by_principal_id")
      .references(() => users.principalId)
      .$type<Id<"user">>(),
    answer: jsonb("answer").$type<Answer | null>(),
  },
  (table) => [
    check(
      "questions_kind_check",
      sql`${table.kind} in ('text', 'choice', 'approval', 'edit-artifact')`,
    ),
    // Ticket 14: Question adalah satu-satunya titik commit sebuah giliran —
    // dua Question terbuka untuk satu StepRun adalah keadaan yang tidak
    // boleh bisa ditulis (spec: "Skema database").
    uniqueIndex("questions_one_open_per_step_run")
      .on(table.stepRunId)
      .where(sql`${table.answeredAt} is null`),
    index("questions_waiting_for_me_idx")
      .on(table.createdAt)
      .where(sql`${table.answeredAt} is null`),
  ],
);
