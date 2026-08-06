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
  it("accepts one arm per Question kind and rejects a mismatched kind", () => {
    const textAnswer: Answer = { kind: "text", value: "Use approach two." };
    const choiceAnswer: Answer = { kind: "choice", ids: ["a", "b"] };
    const approvalAnswer: Answer = { kind: "approval", approved: false, reason: "scope" };
    const editAnswer: Answer = { kind: "edit-artifact", content: "# Revised PRD" };
    for (const answer of [textAnswer, choiceAnswer, approvalAnswer, editAnswer]) {
      expect(answerSchema.safeParse(answer).success).toBe(true);
    }
    // The union is closed — an unknown kind is rejected, and so is an arm
    // whose fields don't match its kind (a text answer is not allowed to
    // carry `approved`).
    expect(answerSchema.safeParse({ kind: "email", value: "x" }).success).toBe(false);
    expect(answerSchema.safeParse({ kind: "approval", approved: true, value: "x" }).success).toBe(false);
  });

  it("the Question schema still accepts every declared kind", () => {
    for (const q of [question("text"), question("approval"), question("choice"), question("edit-artifact")]) {
      expect(questionSchema.safeParse(q).success).toBe(true);
    }
  });
});

describe("renderAnswerForAgent (issue 13, AC5)", () => {
  it("approved: false is data — it renders as the rejection text, not a failure", () => {
    const rendered = renderAnswerForAgent(question("approval"), {
      kind: "approval",
      approved: false,
      reason: "costs too much",
    });
    expect(rendered).toContain("rejected");
    expect(rendered).toContain("costs too much");
    expect(rendered).toContain("Approve this plan?");
  });

  it("an approval without a reason still reaches the agent as the next prompt", () => {
    expect(renderAnswerForAgent(question("approval"), { kind: "approval", approved: true })).toContain("approved");
  });

  it("a choice answer renders option labels, resolving ids through the Question", () => {
    const rendered = renderAnswerForAgent(question("choice"), { kind: "choice", ids: ["a"], other: "or maybe C" });
    expect(rendered).toContain("Variant A — fast");
    expect(rendered).toContain("or maybe C");
  });

  it("a text answer is the free-form body", () => {
    expect(renderAnswerForAgent(question("text"), { kind: "text", value: "Go green." })).toContain("Go green.");
  });

  it("an edit-artifact answer sends the edited content back to the agent", () => {
    const rendered = renderAnswerForAgent(question("edit-artifact"), {
      kind: "edit-artifact",
      content: "# Revised PRD",
    });
    expect(rendered).toContain("edited the artifact");
    expect(rendered).toContain("# Revised PRD");
  });
});
