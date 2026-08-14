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

function question(kind: "text" | "approval" | "choice" | "edit-artifact"): Question {
  switch (kind) {
    case "text":
      return { kind: "text", body: "Which approach should I take?" };
    case "approval":
      return { kind: "approval", body: "Approve this plan?" };
    case "choice":
      return {
        kind: "choice",
        body: "Pick a variant",
        options: [
          { id: "a", label: "Variant A", description: "fast" },
          { id: "b", label: "Variant B" },
        ],
        multi: false,
        allowOther: true,
      };
    case "edit-artifact":
      return { kind: "edit-artifact", body: "Update the PRD", artifactKey: "prd" };
  }
}

describe("Answer schema (issue 13, AC4)", () => {
  // Tabel tersembunyi (klausa 2) sekaligus union tertutup (klausa 1):
  // loop atas literal ber-assertion di dalamnya, dan answerSchema adalah
  // discriminatedUnion tertutup — satu baris per arm tanpa pengecualian,
  // plus nilai di luar himpunan dan arm dengan field tak cocok.
  type AnswerSchemaCase =
    | { case: string; answer: Answer; expected: true }
    | { case: string; answer: Record<string, unknown>; expected: false };

  it.each([
    { case: "teks", answer: { kind: "text", value: "Use approach two." }, expected: true },
    { case: "pilihan", answer: { kind: "choice", ids: ["a", "b"] }, expected: true },
    { case: "persetujuan", answer: { kind: "approval", approved: false, reason: "scope" }, expected: true },
    { case: "edit-artifact", answer: { kind: "edit-artifact", content: "# Revised PRD" }, expected: true },
    { case: "teks dengan nilai kosong", answer: { kind: "text", value: "" }, expected: true },
    { case: "teks dengan nilai hanya whitespace", answer: { kind: "text", value: "   " }, expected: true },
    { case: "kind di luar union", answer: { kind: "email", value: "x" }, expected: false },
    { case: "field arm tak cocok", answer: { kind: "approval", approved: true, value: "x" }, expected: false },
  ] satisfies AnswerSchemaCase[])("$case", (row) => {
    expect(answerSchema.safeParse(row.answer).success).toBe(row.expected);
  });

  // Union tertutup Question juga berutang satu baris per arm (klausa 1),
  // dan blok string atas `body` menuntut baris kosong dan whitespace-saja.
  type QuestionSchemaCase = { case: string; question: Question; expected: true };

  it.each([
    { case: "teks", question: question("text"), expected: true },
    { case: "persetujuan", question: question("approval"), expected: true },
    { case: "pilihan", question: question("choice"), expected: true },
    { case: "edit-artifact", question: question("edit-artifact"), expected: true },
    { case: "body kosong", question: { kind: "text", body: "" }, expected: true },
    { case: "body hanya whitespace", question: { kind: "text", body: "   " }, expected: true },
  ] satisfies QuestionSchemaCase[])("$case", (row) => {
    expect(questionSchema.safeParse(row.question).success).toBe(row.expected);
  });
});

describe("renderAnswerForAgent (issue 13, AC5)", () => {
  // Union Answer["kind"] tertutup: satu baris per arm (klausa 1). Assertion
  // lewat toContain, bukan kesetaraan — baris membawa expectedFragments:
  // banyak expect di dalam satu baris bukan tabel tersembunyi (klausa 2
  // mencacah kasus, bukan assertion di dalam satu kasus).
  // lewati: answer/ids/elemen yang sendirinya kosong — id kosong jatuh ke
  //   fallback `: id` di question.ts:116, sama dengan id tak dikenal
  // lewati: answer/value/kosong — toContain("") selalu benar; nilai kosong
  //   tidak diolah khusus di question.ts:108 (append verbatim)
  type RenderAnswerForAgentCase = {
    case: string;
    question: Question;
    answer: Answer;
    expectedFragments: string[];
  };

  it.each([
    {
      case: "persetujuan ditolak adalah data, bukan kegagalan",
      question: question("approval"),
      answer: { kind: "approval", approved: false, reason: "costs too much" },
      expectedFragments: ["rejected", "costs too much", "Approve this plan?"],
    },
    {
      case: "persetujuan tanpa alasan",
      question: question("approval"),
      answer: { kind: "approval", approved: true },
      expectedFragments: ["approved", "Approve this plan?"],
    },
    {
      case: "pilihan meresolusi id lewat Question",
      question: question("choice"),
      answer: { kind: "choice", ids: ["a", "b"], other: "or maybe C" },
      expectedFragments: ["Variant A — fast", "Variant B", "or maybe C", "Pick a variant"],
    },
    {
      case: "pilihan tanpa id terpilih",
      question: question("choice"),
      answer: { kind: "choice", ids: [] },
      expectedFragments: ["(none)", "Pick a variant"],
    },
    {
      case: "pilihan dengan id duplikat tidak didedup",
      question: question("choice"),
      answer: { kind: "choice", ids: ["a", "a"] },
      expectedFragments: ["Variant A — fast, Variant A — fast"],
    },
    {
      case: "teks adalah isi bebas",
      question: question("text"),
      answer: { kind: "text", value: "Go green." },
      expectedFragments: ["Go green.", "Which approach should I take?"],
    },
    {
      case: "edit-artifact mengirim konten yang diedit",
      question: question("edit-artifact"),
      answer: { kind: "edit-artifact", content: "# Revised PRD" },
      expectedFragments: ["edited the artifact", "# Revised PRD", "Update the PRD"],
    },
  ] satisfies RenderAnswerForAgentCase[])("$case", ({ question, answer, expectedFragments }) => {
    const rendered = renderAnswerForAgent(question, answer);
    for (const fragment of expectedFragments) {
      expect(rendered).toContain(fragment);
    }
  });
});

describe("renderHumanTimeoutForAgent (issue #24)", () => {
  // prosa: klausa 3 — yang ditanya bukan sebuah baris: notice waktu-habis
  // adalah satu rendering tetap (konstanta teks di question.ts:136) yang
  // menyisipkan body, bukan pemetaan input → output yang terbagi per kelas.
  it("merender notice tak-ada-jawaban dengan body Question, agar agen melanjutkan dari percakapan yang sama", () => {
    const rendered = renderHumanTimeoutForAgent(question("approval"));
    expect(rendered).toContain("No one answered");
    expect(rendered).toContain("Approve this plan?");
  });
});
