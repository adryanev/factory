import { LineCounter, parseDocument } from "yaml";
import { pipelineSchema, type Pipeline } from "./schema.js";
import { locateIssue, type ValidationIssue } from "./errors.js";

export type { ValidationIssue } from "./errors.js";
export type { Pipeline } from "./schema.js";

export type ValidationResult =
  | { valid: true; pipeline: Pipeline }
  | { valid: false; issues: ValidationIssue[] };

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
  const result = pipelineSchema.safeParse(raw);

  if (result.success) {
    return { valid: true, pipeline: result.data };
  }

  const issues = result.error.issues.map((issue) => locateIssue(doc, lineCounter, issue));
  return { valid: false, issues };
}
