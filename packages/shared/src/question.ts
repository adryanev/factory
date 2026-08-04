/**
 * Question / Answer, closed union (spec.md, "Step yang menunggu manusia").
 * Lives in its own module so the three consumers — control plane (stores and
 * serves), Runner (posts the Question, feeds the answer back as the next-turn
 * prompt), web (renders the answer form) — all reach one Zod schema and can
 * never drift (issue 13, AC4).
 *
 * The Question shape is pinned by issue 13's acceptance criteria (text /
 * choice / approval) plus the one kind that grew later, `edit-artifact` —
 * `text` + CHECK / discriminated union rather than an enum, because the set
 * has already grown once and will grow again (spec: "Skema database").
 *
 * The Answer mirrors the Question's `kind` one-for-one. `approved: false` is
 * deliberately not a failure anywhere in the union — it is data, sent back to
 * the agent as the prompt of the next turn; what it does to the Graph is the
 * Step's own `onReject: fail | continue` property, never implied by the
 * answer value (spec: "Penolakan adalah data").
 */
import { z } from "zod";

export const questionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const QUESTION_KINDS = ["text", "choice", "approval", "edit-artifact"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

const questionTextSchema = z.object({ kind: z.literal("text"), body: z.string() });
const questionChoiceSchema = z.object({
  kind: z.literal("choice"),
  body: z.string(),
  options: z.array(questionOptionSchema).min(1),
  multi: z.boolean(),
  allowOther: z.boolean(),
});
const questionApprovalSchema = z.object({ kind: z.literal("approval"), body: z.string() });
const questionEditArtifactSchema = z.object({
  kind: z.literal("edit-artifact"),
  body: z.string(),
  artifactKey: z.string(),
});

export const questionSchema = z.discriminatedUnion("kind", [
  questionTextSchema,
  questionChoiceSchema,
  questionApprovalSchema,
  questionEditArtifactSchema,
]);
export type Question = z.infer<typeof questionSchema>;

const answerTextSchema = z.object({ kind: z.literal("text"), value: z.string() }).strict();
const answerChoiceSchema = z
  .object({
    kind: z.literal("choice"),
    ids: z.array(z.string()),
    other: z.string().optional(),
  })
  .strict();
const answerApprovalSchema = z
  .object({
    kind: z.literal("approval"),
    approved: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();
const answerEditArtifactSchema = z.object({ kind: z.literal("edit-artifact"), content: z.string() }).strict();

/** The closed Answer union — one arm per Question `kind` (issue 13, AC4). */
export const answerSchema = z.discriminatedUnion("kind", [
  answerTextSchema,
  answerChoiceSchema,
  answerApprovalSchema,
  answerEditArtifactSchema,
]);
export type Answer = z.infer<typeof answerSchema>;

/**
 * The arm of the Question union a given `kind` matches — used by the Runner
 * to compile a Step's `ask:` into exactly one arm of the output contract's
 * `question` branch.
 */
export const questionSchemaByKind: Record<QuestionKind, z.ZodTypeAny> = {
  text: questionTextSchema,
  choice: questionChoiceSchema,
  approval: questionApprovalSchema,
  "edit-artifact": questionEditArtifactSchema,
};

function optionLabel(option: QuestionOption): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

/**
 * Renders a human's Answer as the text of the next turn's prompt (issue 13,
 * AC5): the control plane stores it and the Runner's claim carries the
 * already-rendered block, so the agent continues from the same conversation
 * with the answer in front of it. `approved: false` is passed through
 * verbatim — it reaches the agent as the prompt, and only the Step's
 * `onReject:` decides what it does to the Graph.
 */
export function renderAnswerForAgent(question: Question, answer: Answer): string {
  const body = question.body.trim();
  switch (answer.kind) {
    case "text":
      return `The human answered your question (${body}):\n${answer.value}`;
    case "approval":
      return answer.approved
        ? `The human ${answer.reason ? `approved (${answer.reason.trim()}): ` : "approved: "}${body}`
        : `The human rejected${answer.reason ? ` with the reason: ${answer.reason.trim()}` : ""}:\n${body}`;
    case "choice": {
      const chosen = question.kind === "choice" ? answer.ids.map((id) => {
        const option = question.options.find((candidate) => candidate.id === id);
        return option ? optionLabel(option) : id;
      }) : answer.ids;
      const picked = chosen.length > 0 ? chosen.join(", ") : "(none)";
      const other = answer.other !== undefined && answer.other !== "" ? `\n(additional text: ${answer.other})` : "";
      return `The human chose: ${picked}${other}\n(question: ${body})`;
    }
    case "edit-artifact":
      return `The human edited the artifact (${body}):\n${answer.content}`;
  }
}

/**
 * Renders a Question the way a human reader should see it — the answer form
 * the web UI builds on. Each kind gets its own presentation (a free-text
 * field, a pick list, an approve/reject choice).
 */
export function renderQuestionForHuman(question: Question): {
  kind: QuestionKind;
  body: string;
  options?: { id: string; label: string }[];
  multi: boolean;
  allowOther: boolean;
  artifactKey?: string;
} {
  switch (question.kind) {
    case "choice":
      return {
        kind: "choice",
        body: question.body,
        options: question.options.map((option) => ({ id: option.id, label: optionLabel(option) })),
        multi: question.multi,
        allowOther: question.allowOther,
      };
    default:
      return {
        kind: question.kind,
        body: question.body,
        multi: false,
        allowOther: false,
        ...(question.kind === "edit-artifact" ? { artifactKey: question.artifactKey } : {}),
      };
  }
}
