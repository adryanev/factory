import { z } from "zod";
import { KEY_PATTERN, KEY_PATTERN_DESCRIPTION } from "./key.js";

/**
 * The Output contract: a small type language of its own (spec.md, "Kontrak
 * Output"), not JSON Schema. JSON Schema was rejected because we would still
 * have to write a validator that rejects most of its surface (`oneOf`,
 * `$ref`, `patternProperties`) — a subset written honestly is cheaper than a
 * fence around a standard we don't fully accept.
 *
 * Top level: a mapping of name to descriptor. A descriptor is either
 * `{ type: <scalar> }` or `{ type: array, items: <scalar> | <flat object> }`.
 * Scalars are string | number | boolean. Flat objects map field name to
 * scalar type and do not nest. Every field is required — optionality does
 * not exist in v1. `description:` is optional and has exactly one reader:
 * the format-instruction block generator below.
 *
 * Two identifier shapes carry the Key constraint `[a-z0-9][a-z0-9._-]{0,63}`
 * (issue 9, AC2): the `key` field inside an array's flat object — what a
 * `branchesFrom` reads to fan out — constrains the *value* in the compiled
 * schema, not only at fan-out, so an agent whose emitted Key is not
 * git-ref-safe fixes itself inside the turn, while the session is still
 * alive. The declared `outputs:` names themselves are deliberately *not*
 * constrained (the winning prototype names an Output `prTitle`), and the
 * agent is told them rather than asked to invent them.
 */

export const SCALAR_TYPES = ["string", "number", "boolean"] as const;
export type ScalarType = (typeof SCALAR_TYPES)[number];

export const scalarTypeSchema = z.enum(SCALAR_TYPES);

/** Field name -> scalar type. No nesting, by construction: values are scalars only. */
export const flatObjectDescriptorSchema = z.record(z.string(), scalarTypeSchema);
export type FlatObjectDescriptor = z.infer<typeof flatObjectDescriptorSchema>;

const scalarOutputDescriptorSchema = z.object({
  type: scalarTypeSchema,
  description: z.string().optional(),
});

const arrayOutputDescriptorSchema = z.object({
  type: z.literal("array"),
  items: z.union([scalarTypeSchema, flatObjectDescriptorSchema]),
  description: z.string().optional(),
});

export const outputDescriptorSchema = z.union([
  arrayOutputDescriptorSchema,
  scalarOutputDescriptorSchema,
]);
export type OutputDescriptor = z.infer<typeof outputDescriptorSchema>;

/** The `outputs:` mapping of a Step. */
export const outputsMapSchema = z.record(z.string(), outputDescriptorSchema);
export type OutputsMap = z.infer<typeof outputsMapSchema>;

function scalarZod(type: ScalarType): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
  }
}

function flatObjectZod(descriptor: FlatObjectDescriptor): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [field, type] of Object.entries(descriptor)) {
    // A field named `key` is the fan-out Key (`branchesFrom` reads it) — it
    // compiles to a `string` constrained to the Key pattern, so an agent that
    // emits a Key that is not git-ref-safe is rejected *here*, with the
    // session still alive, instead of at fan-out (issue 9, AC2).
    shape[field] =
      field === "key" ? z.string().regex(KEY_PATTERN, KEY_PATTERN_DESCRIPTION) : scalarZod(type);
  }
  // .strict(): every field is required and no undeclared field is
  // tolerated — this compiled schema is the authoritative gate on what an
  // agent's Output may contain (spec.md, "Kontrak Output").
  return z.object(shape).strict();
}

function itemsZod(items: ScalarType | FlatObjectDescriptor): z.ZodTypeAny {
  return typeof items === "string" ? scalarZod(items) : flatObjectZod(items);
}

function descriptorZod(descriptor: OutputDescriptor): z.ZodTypeAny {
  if (descriptor.type === "array") {
    return z.array(itemsZod(descriptor.items));
  }
  return scalarZod(descriptor.type);
}

/**
 * Compiles `outputs:` into the Zod schema for the "done" arm's `outputs`
 * object. This is the single place the outputs mini-language is turned into
 * a runtime validator — the schema must not live in two places.
 */
export function compileOutputsSchema(outputs: OutputsMap | undefined): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, descriptor] of Object.entries(outputs ?? {})) {
    shape[name] = descriptorZod(descriptor);
  }
  // .strict(): an agent Output carrying a field nobody declared is a bug,
  // not data to silently drop — control plane is the authoritative gate.
  return z.object(shape).strict();
}

/**
 * Question / Answer, closed union (spec.md, "Step yang menunggu manusia").
 * Lives here because compiling a Step's `ask:` into its output contract
 * needs exactly one arm of it — the arm matching `ask.kind`.
 */
export const questionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

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

const questionSchemaByKind: Record<QuestionKind, z.ZodTypeAny> = {
  text: questionTextSchema,
  choice: questionChoiceSchema,
  approval: questionApprovalSchema,
  "edit-artifact": questionEditArtifactSchema,
};

/** The tag name is a system constant. Nobody ever types it. */
export const FACTORY_OUTPUT_TAG = "factory-output";

export interface StepOutputContractSource {
  outputs?: OutputsMap;
  ask?: { kind: QuestionKind };
}

/**
 * Compiles a Step's `outputs:` (and `ask:`, if present) into the
 * discriminated union the agent's single `<factory-output>` tag must match.
 *
 * A Step without `ask:` has only the `done` arm. A Step with `ask:` always
 * gets a `question` arm too, even when `outputs:` is empty — without the
 * tag, "asking" and "finished" are indistinguishable in a single stdout
 * capture.
 */
export function compileStepOutputContract(step: StepOutputContractSource): z.ZodTypeAny {
  const doneArm = z.object({
    kind: z.literal("done"),
    outputs: compileOutputsSchema(step.outputs),
  });

  if (!step.ask) {
    return z.discriminatedUnion("kind", [doneArm]);
  }

  const questionArm = z.object({
    kind: z.literal("question"),
    question: questionSchemaByKind[step.ask.kind],
  });

  return z.discriminatedUnion("kind", [questionArm, doneArm]);
}

function describeScalar(type: ScalarType): string {
  return type;
}

function describeItems(items: ScalarType | FlatObjectDescriptor): string {
  if (typeof items === "string") return describeScalar(items);
  const fields = Object.entries(items)
    .map(([field, type]) => `${field}: ${type}`)
    .join(", ");
  return `{ ${fields} }`;
}

function describeDescriptor(descriptor: OutputDescriptor): string {
  if (descriptor.type === "array") {
    return `array of ${describeItems(descriptor.items)}`;
  }
  return describeScalar(descriptor.type);
}

/**
 * Generates the format-instruction block appended to the prompt, derived
 * from `outputs:` (and `ask:`). This is the Runner's job at runtime, but the
 * generator lives next to the compiled schema on purpose: the schema must
 * not live in two places, and this is the one function allowed to describe
 * it in English for the agent.
 */
export function generateFormatInstructions(step: StepOutputContractSource): string {
  const lines: string[] = [];
  lines.push(
    `Emit exactly one <${FACTORY_OUTPUT_TAG}> tag on its own in your final output, containing a single JSON object.`
  );

  const outputEntries = Object.entries(step.outputs ?? {});
  lines.push("");
  lines.push("When you are finished:");
  lines.push(`<${FACTORY_OUTPUT_TAG}>{"kind":"done","outputs":{...}}</${FACTORY_OUTPUT_TAG}>`);
  if (outputEntries.length > 0) {
    lines.push("\"outputs\" fields:");
    for (const [name, descriptor] of outputEntries) {
      const suffix = descriptor.description ? ` — ${descriptor.description}` : "";
      lines.push(`  - ${name}: ${describeDescriptor(descriptor)}${suffix}`);
    }
  } else {
    lines.push('"outputs" must be an empty object: {}');
  }

  if (step.ask) {
    lines.push("");
    lines.push("If you need to ask a human before you can finish:");
    lines.push(
      `<${FACTORY_OUTPUT_TAG}>{"kind":"question","question":{"kind":"${step.ask.kind}",...}}</${FACTORY_OUTPUT_TAG}>`
    );
  }

  return lines.join("\n");
}

/**
 * The final prompt sent to the agent: the Step's own prompt text (the
 * `promptFile:`/`prompt:` content) with the generated format-instruction
 * block appended. This is what makes "UI menampilkan prompt final yang
 * dikirim, bukan hanya isi file aslinya" (issue 9, AC5) possible — the prompt
 * that reaches the agent is deliberately not the verbatim file content
 * (spec.md, "Kontrak Output"), and both the Runner (which sends it) and the
 * control plane (which persists it for the UI) build it through this one
 * function so the two can never drift.
 */
export function renderFinalPrompt(basePrompt: string | undefined, step: StepOutputContractSource): string {
  const block = generateFormatInstructions(step);
  if (basePrompt === undefined || basePrompt === "") {
    return block;
  }
  return `${basePrompt}\n\n${block}`;
}
