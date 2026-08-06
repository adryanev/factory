import { describe, expect, it } from "vitest";
import { joinManifestSchema, resolveEffectiveStep, validatePipelineDefinition, type Pipeline } from "../index.js";

const FANOUT_DEFINITION = `version: 1
name: p
repo: backend
steps:
  plan:
    prompt: plan it
  implement:
    after: [plan]
    branches:
      - key: agent-a
        agent: codex
      - key: agent-b
        repo: frontend
    prompt: do the work
    runsOn: [exec:docker]
`;

function pipeline(): Pipeline {
  const result = validatePipelineDefinition(FANOUT_DEFINITION);
  if (!result.valid) throw new Error("fixture must validate");
  return result.pipeline;
}

describe("resolveEffectiveStep: a fan-out branch is a full Step (issue #11)", () => {
  it("merges a branches: entry's overrides into the parent Step — a branch with its own agent runs as itself", () => {
    const codexBranch = resolveEffectiveStep(pipeline(), "implement", "agent-a");
    expect(codexBranch).toMatchObject({ agent: "codex", prompt: "do the work", runsOn: ["exec:docker"] });
  });

  it("a branches: entry with its own repo keeps it, and everything else inherits from the parent", () => {
    const frontendBranch = resolveEffectiveStep(pipeline(), "implement", "agent-b");
    expect(frontendBranch).toMatchObject({ repo: "frontend", prompt: "do the work", runsOn: ["exec:docker"] });
  });

  it("a branchesFrom branch (no definition entry) resolves to the parent Step unchanged", () => {
    const branch = resolveEffectiveStep(pipeline(), "implement", "agent-zzz"); // a key the constants list does not name
    expect(branch).toMatchObject({ prompt: "do the work", runsOn: ["exec:docker"] });
  });

  it("a non-fan-out StepRun (branch_key null) resolves to the Step as written", () => {
    expect(resolveEffectiveStep(pipeline(), "plan", null)).toMatchObject({ prompt: "plan it" });
  });

  it("returns undefined for a Step the Pipeline does not have", () => {
    expect(resolveEffectiveStep(pipeline(), "nope", null)).toBeUndefined();
  });
});

describe("minBranches", () => {
  it("defaults to 1 (closes 'all over an empty set is true') but accepts an explicit 0 opt-out", () => {
    const withDefault = validatePipelineDefinition(`version: 1
name: p
repo: backend
steps:
  plan:
    prompt: plan
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
  implement:
    after: [plan]
    branchesFrom: { step: plan, output: variants }
    prompt: work
`);
    expect(withDefault.valid).toBe(true);
    if (withDefault.valid) {
      expect(withDefault.pipeline.steps.implement?.minBranches).toBe(1);
    }

    const withZero = validatePipelineDefinition(`version: 1
name: p
repo: backend
steps:
  plan:
    prompt: plan
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
  implement:
    after: [plan]
    branchesFrom: { step: plan, output: variants }
    minBranches: 0
    prompt: work
`);
    expect(withZero.valid).toBe(true);
    if (withZero.valid) {
      expect(withZero.pipeline.steps.implement?.minBranches).toBe(0);
    }
  });
});

describe("joinManifestSchema: the [{ key, repo, branch, sha, outcome, outputs }] shape the Join receives", () => {
  it("accepts a well-formed manifest entry", () => {
    const parsed = joinManifestSchema.safeParse([
      { key: "agent-a", repo: "backend", branch: "run/run_1/implement/agent-a/t1-a1", sha: "abc", outcome: "succeeded", outputs: { x: 1 } },
    ]);
    expect(parsed.success).toBe(true);
  });

  it("accepts a non-terminal outcome — a Join is claimable before every branch is decided", () => {
    const parsed = joinManifestSchema.safeParse([
      { key: "agent-a", repo: "backend", branch: "b", sha: null, outcome: "awaiting-human", outputs: null },
    ]);
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown outcome — a misspelt branch verdict must not travel as data", () => {
    const parsed = joinManifestSchema.safeParse([
      { key: "agent-a", repo: "backend", branch: "b", sha: null, outcome: "succeded", outputs: null },
    ]);
    expect(parsed.success).toBe(false);
  });

  it("rejects an entry missing the key — every branch is named", () => {
    const parsed = joinManifestSchema.safeParse([
      { repo: "backend", branch: "b", sha: null, outcome: "succeeded", outputs: null },
    ]);
    expect(parsed.success).toBe(false);
  });
});
