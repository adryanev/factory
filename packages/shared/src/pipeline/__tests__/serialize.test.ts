import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializePipeline } from "../serialize.js";
import { validatePipelineDefinition } from "../validate.js";
import type { Pipeline } from "../schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "__fixtures__");

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), "utf-8");
}

function parsed(name: string): Pipeline {
  const result = validatePipelineDefinition(fixture(name));
  if (!result.valid) throw new Error(`fixture ${name} must validate: ${JSON.stringify(result.issues)}`);
  return result.pipeline;
}

describe("serializePipeline", () => {
  it("round-trips a prototype fixture: serialize -> validate -> parse -> serialize is byte-identical", () => {
    const pipeline = parsed("d-verdict-01-fanout-review.yaml");
    const text = serializePipeline(pipeline);
    const again = validatePipelineDefinition(text);
    expect(again.valid).toBe(true);
    if (again.valid) {
      expect(serializePipeline(again.pipeline)).toBe(text);
    }
  });

  it("round-trips the kind: pull-request fixture", () => {
    const pipeline = parsed("accept-kind-step-plain-after.yaml");
    const text = serializePipeline(pipeline);
    const again = validatePipelineDefinition(text);
    expect(again.valid).toBe(true);
    if (again.valid) {
      expect(serializePipeline(again.pipeline)).toBe(text);
    }
  });

  it("omits schema defaults so the output stays minimal: after, minBranches, onReject, humanTimeout", () => {
    const result = validatePipelineDefinition(`version: 1
name: solo
repo: frontend
steps:
  lint:
    run: pnpm lint
`);
    if (!result.valid) throw new Error("inline pipeline must validate");
    const text = serializePipeline(result.pipeline);
    expect(text).not.toContain("after:");
    expect(text).not.toContain("minBranches:");
    expect(text).not.toContain("onReject:");
    expect(text).not.toContain("humanTimeout:");
    expect(text).toContain("run: pnpm lint");
  });

  it("emits every non-default field in fixed order, including branches and outputs", () => {
    const text = serializePipeline(parsed("d-verdict-01-fanout-review.yaml"));
    expect(text).toContain("branches:");
    expect(text).toContain("key: agent-a");
    expect(text).toContain("outputs:");
    expect(text).toContain("type: array");
    // Key order: the steps map lists plan first, implement second.
    const planIdx = text.indexOf("  plan:");
    const implementIdx = text.indexOf("  implement:");
    expect(planIdx).toBeGreaterThan(-1);
    expect(implementIdx).toBeGreaterThan(planIdx);
  });

  it("serialized output always re-validates for every accept fixture in the corpus", () => {
    const accepts = [
      "accept-branches-from.yaml",
      "accept-kind-step-plain-after.yaml",
      "d-verdict-01-fanout-review.yaml",
      "d-verdict-02-linear.yaml",
      "d-verdict-03-cross-repo.yaml",
    ];
    for (const name of accepts) {
      const text = serializePipeline(parsed(name));
      const again = validatePipelineDefinition(text);
      expect(again.valid, name).toBe(true);
    }
  });
});
