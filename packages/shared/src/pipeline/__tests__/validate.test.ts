import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePipelineDefinition, type ValidationResult } from "../validate.js";

function fixture(name: string): string {
  const path = fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));
  return readFileSync(path, "utf-8");
}

function expectValid(result: ValidationResult): asserts result is Extract<ValidationResult, { valid: true }> {
  if (!result.valid) {
    throw new Error(
      `expected a valid Pipeline, got issues:\n${result.issues
        .map((i) => `  ${i.line ?? "?"}:${i.column ?? "?"} ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }
}

function expectInvalid(result: ValidationResult): asserts result is Extract<ValidationResult, { valid: false }> {
  if (result.valid) {
    throw new Error("expected the Pipeline to be rejected, but it validated");
  }
}

function messages(result: Extract<ValidationResult, { valid: false }>): string[] {
  return result.issues.map((i) => i.message);
}

// ---------------------------------------------------------------------------
// Existing prototype fixtures must keep passing (spec.md, "Definisi
// Pipeline" — the format won by prototypes/pipeline-format/d-verdict/).
// ---------------------------------------------------------------------------

describe("winning prototype fixtures still validate", () => {
  it("d-verdict/01-fanout-review (fan-out + human review)", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-01-fanout-review.yaml"));
    expectValid(result);
    expect(result.pipeline.name).toBe("Rencana, tiga varian, review manusia");
    expect(Object.keys(result.pipeline.steps)).toEqual([
      "plan",
      "implement",
      "pick-best",
      "review",
      "test",
    ]);
  });

  it("d-verdict/02-linear (straight chain, no fan-out, no HITL)", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-02-linear.yaml"));
    expectValid(result);
    expect(Object.keys(result.pipeline.steps)).toEqual(["lint", "build", "test"]);
  });

  it("d-verdict/03-cross-repo (repo-keyed fan-out + control-plane pull-request Step)", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-03-cross-repo.yaml"));
    expectValid(result);
    expect(Object.keys(result.pipeline.steps)).toEqual([
      "contract",
      "implement",
      "open-pr",
      "report",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Every rule the schema must enforce: one accepted case, one rejected case.
// ---------------------------------------------------------------------------

describe("branches: XOR branchesFrom:", () => {
  it("accepts branchesFrom for dynamic fan-out", () => {
    const result = validatePipelineDefinition(fixture("accept-branches-from.yaml"));
    expectValid(result);
  });

  it("rejects a Step declaring both branches: and branchesFrom:", () => {
    const result = validatePipelineDefinition(fixture("reject-branches-xor-branches-from.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("mutually exclusive"))).toBe(true);
  });
});

describe("agent:/prompt:/promptFile: XOR run:", () => {
  it("accepts a Step using only run:", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-02-linear.yaml"));
    expectValid(result);
  });

  it("rejects a Step declaring both run: and promptFile:", () => {
    const result = validatePipelineDefinition(fixture("reject-run-xor-agent.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("exactly one of prompt:/promptFile:/agent:, run:, or kind:"))).toBe(true);
  });
});

describe("prompt: XOR promptFile:", () => {
  it("accepts a Step using only promptFile:", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-01-fanout-review.yaml"));
    expectValid(result);
  });

  it("rejects a Step declaring both prompt: and promptFile:", () => {
    const result = validatePipelineDefinition(fixture("reject-prompt-xor-prompt-file.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("'prompt:' and 'promptFile:' are mutually exclusive"))).toBe(true);
  });
});

describe("Keys unique within branches:", () => {
  it("accepts distinct Keys per branch", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-01-fanout-review.yaml"));
    expectValid(result);
  });

  it("rejects a duplicate Key within branches:", () => {
    const result = validatePipelineDefinition(fixture("reject-duplicate-branch-key.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("duplicate Key"))).toBe(true);
  });
});

describe("after: points at ids that exist", () => {
  it("accepts after: referring to a declared Step id", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-02-linear.yaml"));
    expectValid(result);
  });

  it("rejects after: referring to an unknown Step id", () => {
    const result = validatePipelineDefinition(fixture("reject-after-unknown-id.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("unknown Step id"))).toBe(true);
  });
});

describe("the Graph is acyclic", () => {
  it("accepts a linear chain", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-02-linear.yaml"));
    expectValid(result);
  });

  it("rejects a cyclic after: dependency", () => {
    const result = validatePipelineDefinition(fixture("reject-cyclic-graph.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.startsWith("cyclic dependency:"))).toBe(true);
  });
});

describe("onHumanTimeout: is meaningful only when humanTimeout: is not none", () => {
  it("accepts onHumanTimeout: alongside an explicit humanTimeout:", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-01-fanout-review.yaml"));
    expectValid(result);
  });

  it("rejects onHumanTimeout: with humanTimeout: left at its none default", () => {
    const result = validatePipelineDefinition(
      fixture("reject-on-human-timeout-without-human-timeout.yaml")
    );
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("only meaningful when humanTimeout:"))).toBe(true);
  });
});

describe("outputs: is only for Steps that have an agent", () => {
  it("accepts outputs: on an agent Step", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-01-fanout-review.yaml"));
    expectValid(result);
  });

  it("rejects outputs: on a run: Step", () => {
    const result = validatePipelineDefinition(fixture("reject-outputs-on-run-step.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("'outputs:' is only valid on a Step with an agent"))).toBe(true);
  });
});

describe("timeout:/attempts: are rejected on a Step with kind:", () => {
  it("accepts a kind: Step without timeout: or attempts:", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-03-cross-repo.yaml"));
    expectValid(result);
  });

  it("rejects timeout: and attempts: on a kind: Step", () => {
    const result = validatePipelineDefinition(fixture("reject-timeout-attempts-on-kind-step.yaml"));
    expectInvalid(result);
    const found = messages(result);
    expect(found.some((m) => m.includes("timeout: is rejected on a Step with kind:"))).toBe(true);
    expect(found.some((m) => m.includes("attempts: is rejected on a Step with kind:"))).toBe(true);
  });
});

describe("after: pointing at a kind: pull-request Step is an error (it is a leaf)", () => {
  it("accepts a kind: pull-request Step with nothing depending on it", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-03-cross-repo.yaml"));
    expectValid(result);
  });

  it("rejects after: pointing at a kind: pull-request Step", () => {
    const result = validatePipelineDefinition(fixture("reject-after-points-to-pull-request.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("is a leaf"))).toBe(true);
  });
});

describe("a Join downstream of a repo-valued fan-out must write an explicit repo:", () => {
  it("accepts a Join that declares repo: explicitly", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-03-cross-repo.yaml"));
    expectValid(result);
  });

  it("rejects a Join that omits repo:", () => {
    const result = validatePipelineDefinition(fixture("reject-join-missing-repo.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("must declare repo: explicitly"))).toBe(true);
  });
});

describe("the source Step of a branchesFrom must have outputs: of type array-of-object containing key: string", () => {
  it("accepts a source Step whose Output is array of { key, ... }", () => {
    const result = validatePipelineDefinition(fixture("accept-branches-from.yaml"));
    expectValid(result);
  });

  it("rejects a source Step whose Output is a plain scalar", () => {
    const result = validatePipelineDefinition(fixture("reject-branches-from-invalid-source.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("must be type: array with items: a flat object containing key: string"))).toBe(true);
  });
});

describe("a kind: pull-request Step is born once per branch only when its single dep is a fan-out and join: is absent (issue #17, AC3)", () => {
  it("accepts a kind: Step after a plain Step, with join: allowed (born once)", () => {
    const result = validatePipelineDefinition(fixture("accept-kind-step-plain-after.yaml"));
    expectValid(result);
  });

  it("rejects join: on a kind: Step that follows a fan-out", () => {
    const result = validatePipelineDefinition(fixture("reject-kind-step-with-fanout-and-join.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("the head branch would be ambiguous on a Join"))).toBe(true);
  });
});

describe("the kind: surface is closed (issue #17, ticket 24)", () => {
  it("rejects repo: on a Step with kind:", () => {
    const result = validatePipelineDefinition(fixture("reject-repo-on-kind-step.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("repo: is rejected on a Step with kind:"))).toBe(true);
  });

  it("rejects branches:/runsOn:/ask: on a Step with kind:", () => {
    const result = validatePipelineDefinition(fixture("reject-kind-step-closed-surface.yaml"));
    expectInvalid(result);
    const found = messages(result);
    expect(found.some((m) => m.includes("branches: is rejected on a Step with kind:"))).toBe(true);
    expect(found.some((m) => m.includes("runsOn: is rejected on a Step with kind:"))).toBe(true);
    expect(found.some((m) => m.includes("ask: is rejected on a Step with kind:"))).toBe(true);
  });

  it("rejects a kind: Step with no after: — the head branch would be undefined", () => {
    const result = validatePipelineDefinition(fixture("reject-kind-step-empty-after.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("exactly one after:"))).toBe(true);
  });

  it("rejects a kind: Step that omits title:/body:", () => {
    const result = validatePipelineDefinition(fixture("reject-kind-step-missing-title-body.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("must declare title: and body:"))).toBe(true);
  });

  it("rejects base:/title:/body: on a Step without kind:", () => {
    const result = validatePipelineDefinition(fixture("reject-kind-fields-on-plain-step.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("only valid on a Step with kind:"))).toBe(true);
  });
});

describe("a kind: pull-request Step's title:/body: references resolve (issue #17, AC5)", () => {
  it("accepts references to a Step that declares the named string Output", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-03-cross-repo.yaml"));
    expectValid(result);
  });

  it("rejects a title: reference to an Output the Step does not declare", () => {
    const result = validatePipelineDefinition(fixture("reject-title-output-missing.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("has no output named"))).toBe(true);
  });

  it("rejects a title: reference to a non-string Output", () => {
    const result = validatePipelineDefinition(fixture("reject-title-output-not-string.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("must be type: string"))).toBe(true);
  });
});

describe("a Pipeline containing ask: must write concurrency: explicitly", () => {
  it("accepts an ask: Step when the Pipeline declares concurrency:", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-01-fanout-review.yaml"));
    expectValid(result);
  });

  it("rejects an ask: Step when the Pipeline omits concurrency:", () => {
    const result = validatePipelineDefinition(fixture("reject-ask-without-concurrency.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("must declare concurrency: explicitly"))).toBe(true);
  });
});

describe("Key type is constrained [a-z0-9][a-z0-9._-]{0,63}, no slug normalisation", () => {
  it("accepts a lowercase Key", () => {
    const result = validatePipelineDefinition(fixture("d-verdict-01-fanout-review.yaml"));
    expectValid(result);
  });

  it("rejects an uppercase Key instead of silently lower-casing it", () => {
    const result = validatePipelineDefinition(fixture("reject-invalid-key-pattern.yaml"));
    expectInvalid(result);
    expect(messages(result).some((m) => m.includes("must match [a-z0-9]"))).toBe(true);
  });
});

describe("maxRetries: is never written in YAML (issue 9, AC8)", () => {
  it("rejects maxRetries at the Pipeline, Step, and Branch levels, pointing at each line", () => {
    const result = validatePipelineDefinition(fixture("reject-max-retries.yaml"));
    expectInvalid(result);
    const found = result.issues.filter((i) => i.message.includes("derives it from agent capabilities"));
    expect(found).toHaveLength(3);
    expect(found.map((i) => i.path)).toEqual([
      ["maxRetries"],
      ["steps", "plan", "maxRetries"],
      ["steps", "plan", "branches", 0, "maxRetries"],
    ]);
    // Every issue points at a real line in the source text.
    expect(found.every((i) => typeof i.line === "number")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Errors point at a line.
// ---------------------------------------------------------------------------

describe("errors point at a line", () => {
  it("locates the duplicate-Key issue at its branches[] entry", () => {
    const result = validatePipelineDefinition(fixture("reject-duplicate-branch-key.yaml"));
    expectInvalid(result);
    const issue = result.issues.find((i) => i.message.includes("duplicate Key"));
    expect(issue).toBeDefined();
    expect(issue?.line).not.toBeNull();
    expect(typeof issue?.line).toBe("number");
  });

  it("locates a YAML syntax error using the parser's own position", () => {
    const result = validatePipelineDefinition("version: 1\nname: [unterminated\n");
    expectInvalid(result);
    expect(result.issues[0]?.line).not.toBeNull();
  });
});
