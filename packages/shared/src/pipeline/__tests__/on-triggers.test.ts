import { describe, expect, it } from "vitest";
import { validatePipelineDefinition, type ValidationResult } from "../validate.js";

function validPipeline(yaml: string): void {
  const result = validatePipelineDefinition(yaml);
  expect(
    result.valid ? "valid" : result.issues.map((i) => i.message).join("; "),
    "expected a valid Pipeline",
  ).toBe("valid");
}

function expectInvalid(
  result: ValidationResult,
  messagePart: string,
): asserts result is Extract<ValidationResult, { valid: false }> {
  expect(result.valid, "expected the Pipeline to be rejected").toBe(false);
  if (result.valid) return;
  expect(result.issues.some((i) => i.message.includes(messagePart))).toBe(true);
}

const BASE = `
version: 1
name: automation test
repo: frontend
steps:
  lint:
    run: "pnpm lint"
`;

describe("on: trigger block", () => {
  it("is optional — a Pipeline without on: stays manual-trigger-only", () => {
    validPipeline(BASE);
  });

  it("accepts push: with branches, paths, and repos", () => {
    validPipeline(`
version: 1
name: automation test
repo: frontend
on:
  push:
    branches: [main, "feat/**"]
    paths: ["**/*.ts"]
    repos: [backend]
steps:
  lint:
    run: "pnpm lint"
`);
  });

  it("accepts pullRequest: true and schedule:", () => {
    validPipeline(`
version: 1
name: automation test
repo: frontend
on:
  pullRequest: true
  schedule: ["0 3 * * *", "*/30 * * * *"]
steps:
  lint:
    run: "pnpm lint"
`);
  });

  it("rejects an empty on: block", () => {
    const result = validatePipelineDefinition(`
version: 1
name: automation test
repo: frontend
on:
  pullRequest: false
steps:
  lint:
    run: "pnpm lint"
`);
    expectInvalid(result, "at least one trigger");
  });

  it("rejects a malformed cron expression with a line pointer", () => {
    const result = validatePipelineDefinition(`
version: 1
name: automation test
repo: frontend
on:
  schedule: ["0 99 * * *"]
steps:
  lint:
    run: "pnpm lint"
`);
    expectInvalid(result, "not a valid 5-field cron expression");
  });

  it("ignores unknown keys inside on:", () => {
    validPipeline(`
version: 1
name: automation test
repo: frontend
on:
  push:
    branches: [main]
    watched: true
steps:
  lint:
    run: "pnpm lint"
`);
  });
});

describe("concurrency:", () => {
  it("accepts cancel and queue, rejects anything else", () => {
    validPipeline(`${BASE}\nconcurrency: cancel`);
    validPipeline(`${BASE}\nconcurrency: queue`);
    const result = validatePipelineDefinition(`${BASE}\nconcurrency: parallel`);
    expect(result.valid).toBe(false);
  });

  it("still requires an explicit concurrency: for a Pipeline with ask:", () => {
    const withAsk = `
version: 1
name: hitl
repo: frontend
steps:
  plan:
    promptFile: plan.md
  review:
    promptFile: review.md
    ask:
      group: reviewers
      kind: approval
`;
    expectInvalid(validatePipelineDefinition(withAsk), "must declare concurrency: explicitly");
    validPipeline(`${withAsk}\nconcurrency: cancel`);
  });
});
