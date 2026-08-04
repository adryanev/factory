import { describe, expect, it } from "vitest";
import {
  FACTORY_OUTPUT_TAG,
  compileOutputsSchema,
  compileStepOutputContract,
  generateFormatInstructions,
  outputsMapSchema,
  renderFinalPrompt,
  type OutputsMap,
} from "../output-contract.js";

const variantsOutputs: OutputsMap = {
  variants: {
    type: "array",
    items: { key: "string", brief: "string" },
    description: "One entry per implementation variant.",
  },
};

describe("compileOutputsSchema", () => {
  it("compiles a scalar field", () => {
    const schema = compileOutputsSchema({ spec: { type: "string" } });
    expect(schema.safeParse({ spec: "openapi.yaml" }).success).toBe(true);
    expect(schema.safeParse({ spec: 42 }).success).toBe(false);
  });

  it("compiles an array-of-scalar field", () => {
    const schema = compileOutputsSchema({ tags: { type: "array", items: "string" } });
    expect(schema.safeParse({ tags: ["a", "b"] }).success).toBe(true);
    expect(schema.safeParse({ tags: [1, 2] }).success).toBe(false);
  });

  it("compiles an array-of-flat-object field and requires every field", () => {
    const schema = compileOutputsSchema(variantsOutputs);
    expect(
      schema.safeParse({ variants: [{ key: "agent-a", brief: "does the thing" }] }).success
    ).toBe(true);
    expect(schema.safeParse({ variants: [{ key: "agent-a" }] }).success).toBe(false);
  });

  it("compiles to an empty object schema when outputs: is undefined", () => {
    const schema = compileOutputsSchema(undefined);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ anything: 1 }).success).toBe(false);
  });
});

describe("compileStepOutputContract", () => {
  it("gives a Step without ask: only the done arm", () => {
    const schema = compileStepOutputContract({ outputs: variantsOutputs });
    expect(
      schema.safeParse({ kind: "done", outputs: { variants: [{ key: "a", brief: "b" }] } })
        .success
    ).toBe(true);
    expect(
      schema.safeParse({ kind: "question", question: { kind: "text", body: "?" } }).success
    ).toBe(false);
  });

  it("gives a Step with ask: both a done arm and a question arm matching ask.kind", () => {
    const schema = compileStepOutputContract({ ask: { kind: "approval" } });
    expect(schema.safeParse({ kind: "done", outputs: {} }).success).toBe(true);
    expect(
      schema.safeParse({ kind: "question", question: { kind: "approval", body: "OK?" } }).success
    ).toBe(true);
    // The question arm is pinned to the Step's declared ask.kind — a
    // differently-shaped Question (e.g. "text") does not match.
    expect(
      schema.safeParse({ kind: "question", question: { kind: "text", body: "?" } }).success
    ).toBe(false);
  });

  it("requires the done arm's outputs even when outputs: is empty, so asking and finishing stay distinguishable", () => {
    const schema = compileStepOutputContract({ ask: { kind: "text" } });
    expect(schema.safeParse({ kind: "done", outputs: {} }).success).toBe(true);
    expect(schema.safeParse({ kind: "done" }).success).toBe(false);
  });
});

describe("generateFormatInstructions", () => {
  it("names the system tag and every output field", () => {
    const text = generateFormatInstructions({ outputs: variantsOutputs });
    expect(text).toContain(`<${FACTORY_OUTPUT_TAG}>`);
    expect(text).toContain("variants: array of { key: string, brief: string }");
    expect(text).toContain("One entry per implementation variant.");
  });

  it("documents the question arm only when ask: is present", () => {
    const withoutAsk = generateFormatInstructions({ outputs: {} });
    const withAsk = generateFormatInstructions({ outputs: {}, ask: { kind: "approval" } });
    expect(withoutAsk).not.toContain('"kind":"question"');
    expect(withAsk).toContain('"kind":"question"');
    expect(withAsk).toContain('"kind":"approval"');
  });
});

describe("output keys are constrained to [a-z0-9][a-z0-9._-]{0,63} (issue 9, AC2)", () => {
  it("rejects an agent-emitted Key value that is not git-ref-safe, so the agent can fix itself in-turn", () => {
    const schema = compileOutputsSchema(variantsOutputs);
    expect(schema.safeParse({ variants: [{ key: "agent-a", brief: "b" }] }).success).toBe(true);
    // The same shape with a Key the agent invented that would break at
    // fan-out is rejected here — with the session still alive (AC2).
    const bad = schema.safeParse({ variants: [{ key: "My Agent A!", brief: "b" }] });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.message).toContain("[a-z0-9]");
    }
  });

  it("does not constrain non-key string fields", () => {
    const schema = compileOutputsSchema({ brief: { type: "string" } });
    expect(schema.safeParse({ brief: "Anything at all." }).success).toBe(true);
  });

  it("does not constrain declared output names (the winning prototype names one prTitle)", () => {
    expect(outputsMapSchema.safeParse({ prTitle: { type: "string" } }).success).toBe(true);
  });
});

describe("renderFinalPrompt", () => {
  it("appends the format-instruction block to the Step's own prompt text", () => {
    const final = renderFinalPrompt("Plan three variants.\n", variantsOutputs);
    expect(final.startsWith("Plan three variants.\n\n")).toBe(true);
    expect(final).toContain(`<${FACTORY_OUTPUT_TAG}>`);
    expect(final).toContain('"kind":"done"');
  });

  it("is the format block alone when there is no base prompt", () => {
    expect(renderFinalPrompt(undefined, { outputs: {} })).toBe(generateFormatInstructions({ outputs: {} }));
  });
});
