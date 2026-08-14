/**
 * Issue 13, AC4/AC5 — the Answer union is closed and mirrors the Question's
 * `kind` one-for-one, and `approved: false` is data (rendered back to the
 * agent as the next-turn prompt), never a schema failure. `renderAnswerForAgent`
 * is what the control plane stores and the Runner's claim carries, so the
 * rendering rules — especially the rejection-is-data rule — are pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  answerSchema,
  questionSchema,
  renderAnswerForAgent,
  renderHumanTimeoutForAgent,
  type Answer,
  type Question,
} from "./index.js";

type AnswerSchemaCase =
  | { case: string; answer: Answer; expected: true }
  | { case: string; answer: Record<string, unknown>; expected: false };

describe("answerSchema", () => {
  // lewati: string (value, reason, content) — arm-arm memakai z.string() polos di question.ts:54-69, tanpa alfabet, separator, atau batas panjang
  // lewati: koleksi ids — z.array(z.string()) tanpa min/max di question.ts:57
  it.each([
    { case: "jawaban teks diterima", answer: { kind: "text", value: "Use approach two." }, expected: true },
    { case: "jawaban pilihan diterima", answer: { kind: "choice", ids: ["a", "b"] }, expected: true },
    { case: "jawaban persetujuan diterima", answer: { kind: "approval", approved: false, reason: "scope" }, expected: true },
    { case: "jawaban edit-artifact diterima", answer: { kind: "edit-artifact", content: "# Revised PRD" }, expected: true },
    { case: "kind di luar union ditolak", answer: { kind: "email", value: "x" }, expected: false },
    { case: "arm menyelundupkan field arm lain ditolak", answer: { kind: "approval", approved: true, value: "x" }, expected: false },
  ] satisfies AnswerSchemaCase[])("$case", ({ answer, expected }) => {
    expect(answerSchema.safeParse(answer).success).toBe(expected);
  });
});

type QuestionSchemaCase =
  | { case: string; question: Question; expected: true }
  | { case: string; question: Record<string, unknown>; expected: false };

describe("questionSchema", () => {
  // lewati: string (body, id, label, artifactKey) — z.string() polos di question.ts:31-44, tanpa alfabet, separator, atau batas panjang
  // lewati: options/duplikat — tidak ada dedup di question.ts:21-26 (z.object polos)
  it.each([
    { case: "pertanyaan teks diterima", question: { kind: "text", body: "Which approach should I take?" }, expected: true },
    { case: "pertanyaan persetujuan diterima", question: { kind: "approval", body: "Approve this plan?" }, expected: true },
    {
      case: "pertanyaan pilihan diterima",
      question: {
        kind: "choice",
        body: "Pick a variant",
        options: [
          { id: "a", label: "Variant A", description: "fast" },
          { id: "b", label: "Variant B" },
        ],
        multi: false,
        allowOther: true,
      },
      expected: true,
    },
    {
      case: "pertanyaan pilihan dengan satu opsi diterima",
      question: { kind: "choice", body: "Pick a variant", options: [{ id: "a", label: "Variant A" }], multi: false, allowOther: true },
      expected: true,
    },
    {
      case: "pertanyaan pilihan dengan options kosong ditolak",
      question: { kind: "choice", body: "Pick a variant", options: [], multi: false, allowOther: true },
      expected: false,
    },
    {
      case: "pertanyaan pilihan dengan elemen options kosong ditolak",
      question: { kind: "choice", body: "Pick a variant", options: [{}], multi: false, allowOther: true },
      expected: false,
    },
    { case: "pertanyaan edit-artifact diterima", question: { kind: "edit-artifact", body: "Update the PRD", artifactKey: "prd" }, expected: true },
    { case: "kind di luar union ditolak", question: { kind: "survey", body: "x" }, expected: false },
  ] satisfies QuestionSchemaCase[])("$case", ({ question, expected }) => {
    expect(questionSchema.safeParse(question).success).toBe(expected);
  });
});

type RenderAnswerForAgentCase = {
  case: string;
  question: Question;
  answer: Answer;
  expectedFragments: string[];
};

describe("renderAnswerForAgent", () => {
  // lewati: string/whitespace — trim() body & reason di question.ts:105 & :111-112 tak bisa ditahan toContain: fragmen cocok pula dengan string yang belum di-trim
  // lewati: other/"" — cabang question.ts:119 memilih tidak merender baris additional text; ketiadaan fragmen tidak bisa diassert dengan toContain
  // lewati: string/separator & panjang — renderAnswerForAgent hanya menginterpolasi (question.ts:104-125); tidak ada separator atau batas panjang
  it.each([
    {
      case: "jawaban teks diteruskan sebagai body bebas",
      question: { kind: "text", body: "Which approach should I take?" },
      answer: { kind: "text", value: "Go green." },
      expectedFragments: ["Go green."],
    },
    {
      case: "persetujuan tanpa alasan ter-render sebagai approved",
      question: { kind: "approval", body: "Approve this plan?" },
      answer: { kind: "approval", approved: true },
      expectedFragments: ["approved"],
    },
    {
      case: "penolakan dengan alasan ter-render sebagai rejected",
      question: { kind: "approval", body: "Approve this plan?" },
      answer: { kind: "approval", approved: false, reason: "costs too much" },
      expectedFragments: ["rejected", "costs too much", "Approve this plan?"],
    },
    {
      case: "pilihan merender label opsi lewat id question",
      question: {
        kind: "choice",
        body: "Pick a variant",
        options: [
          { id: "a", label: "Variant A", description: "fast" },
          { id: "b", label: "Variant B" },
        ],
        multi: false,
        allowOther: true,
      },
      answer: { kind: "choice", ids: ["a"], other: "or maybe C" },
      expectedFragments: ["Variant A — fast", "or maybe C"],
    },
    {
      case: "pilihan tanpa id ter-render sebagai (none)",
      question: { kind: "choice", body: "Pick a variant", options: [{ id: "a", label: "Variant A" }], multi: false, allowOther: true },
      answer: { kind: "choice", ids: [] },
      expectedFragments: ["(none)", "Pick a variant"],
    },
    {
      case: "jawaban choice atas question non-choice merender id mentah",
      question: { kind: "text", body: "Which approach should I take?" },
      answer: { kind: "choice", ids: ["a"] },
      expectedFragments: ["The human chose: a"],
    },
    {
      case: "edit-artifact mengirim konten suntingan kembali",
      question: { kind: "edit-artifact", body: "Update the PRD", artifactKey: "prd" },
      answer: { kind: "edit-artifact", content: "# Revised PRD" },
      expectedFragments: ["edited the artifact", "# Revised PRD"],
    },
  ] satisfies RenderAnswerForAgentCase[])("$case", ({ question, answer, expectedFragments }) => {
    const rendered = renderAnswerForAgent(question, answer);
    for (const fragment of expectedFragments) {
      expect(rendered).toContain(fragment);
    }
  });
});

describe("renderHumanTimeoutForAgent", () => {
  // prosa (Langkah 1, klausa 3): yang ditanya identitas notice, bukan baris —
  // renderHumanTimeoutForAgent (question.ts:134) hanya membaca question.body dan
  // tidak bercabang atas kind, jadi tabel arm Question hanya mengalikan sumbu
  // yang tidak berinteraksi (Langkah 3, aturan 2).
  it("merender notice tanpa-jawaban dengan body Question, agar agen melanjutkan dari percakapan yang sama", () => {
    const rendered = renderHumanTimeoutForAgent({ kind: "approval", body: "Approve this plan?" });
    expect(rendered).toContain("No one answered");
    expect(rendered).toContain("Approve this plan?");
  });
});
