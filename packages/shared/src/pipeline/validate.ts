import { LineCounter, parseDocument } from "yaml";
import { pipelineSchema, type Pipeline } from "./schema.js";
import { locateIssue, type ValidationIssue } from "./errors.js";
import type { z } from "zod";

export type { ValidationIssue } from "./errors.js";
export type { Pipeline } from "./schema.js";

export type ValidationResult =
  | { valid: true; pipeline: Pipeline }
  | { valid: false; issues: ValidationIssue[] };

/**
 * `maxRetries:` is rejected wherever it is written — Pipeline level, Step
 * level, or Branch level. The Runner derives it from agent capabilities
 * (resume-able → 2, else 0), and sandcastle's own `run()` refuses to start
 * when the two disagree, so a definition that tries to write it would be
 * silently ignored by the Zod object schema (which strips unknown keys)
 * *before* the superRefine ever ran. This walks the raw parsed document
 * instead, where the key is still present, and reports a line-located issue.
 */
const MAX_RETRIES_MESSAGE =
  "maxRetries: is rejected — the Runner derives it from agent capabilities (resume-able → 2, else 0); it cannot be written in YAML.";

function collectMaxRetriesIssues(
  raw: unknown,
  doc: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof raw !== "object" || raw === null) return issues;

  const hasMaxRetries = (node: unknown): node is Record<string, unknown> =>
    typeof node === "object" && node !== null && "maxRetries" in (node as Record<string, unknown>);

  const asZodIssue = (path: (string | number)[]): z.ZodIssue => ({
    code: "custom",
    path,
    message: MAX_RETRIES_MESSAGE,
  });

  const record = raw as Record<string, unknown>;
  if (hasMaxRetries(record)) {
    issues.push(locateIssue(doc, lineCounter, asZodIssue(["maxRetries"])));
  }

  const steps = record["steps"];
  if (typeof steps === "object" && steps !== null) {
    for (const [stepId, step] of Object.entries(steps as Record<string, unknown>)) {
      if (hasMaxRetries(step)) {
        issues.push(locateIssue(doc, lineCounter, asZodIssue(["steps", stepId, "maxRetries"])));
      }
      const branches = (step as Record<string, unknown> | undefined)?.["branches"];
      if (Array.isArray(branches)) {
        branches.forEach((branch, idx) => {
          if (hasMaxRetries(branch)) {
            issues.push(
              locateIssue(doc, lineCounter, asZodIssue(["steps", stepId, "branches", idx, "maxRetries"])),
            );
          }
        });
      }
    }
  }
  return issues;
}

/**
 * Validates a Pipeline definition. Pure function: YAML text in, a result
 * out. No I/O, no clock, no network, no filesystem access — the caller owns
 * reading the file and picking the ref it came from.
 */
export function validatePipelineDefinition(yamlText: string): ValidationResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter, keepSourceTokens: true });

  if (doc.errors.length > 0) {
    const issues: ValidationIssue[] = doc.errors.map((error) => ({
      message: error.message,
      path: [],
      line: error.linePos?.[0]?.line ?? null,
      column: error.linePos?.[0]?.col ?? null,
    }));
    return { valid: false, issues };
  }

  const raw: unknown = doc.toJS();
  const maxRetriesIssues = collectMaxRetriesIssues(raw, doc, lineCounter);
  if (maxRetriesIssues.length > 0) {
    return { valid: false, issues: maxRetriesIssues };
  }

  const result = pipelineSchema.safeParse(raw);

  if (result.success) {
    return { valid: true, pipeline: result.data };
  }

  const issues = result.error.issues.map((issue) => locateIssue(doc, lineCounter, issue));
  return { valid: false, issues };
}
