export { validatePipelineDefinition } from "./validate.js";
export type { ValidationResult, ValidationIssue } from "./validate.js";

export { pipelineSchema, stepSchema, branchSchema, outputRefSchema, joinPolicySchema, askSchema, resolveEffectiveStep } from "./schema.js";
export type { Pipeline, Step, Branch, OutputRef, JoinPolicy } from "./types.js";

export {
  compileOutputsSchema,
  compileStepOutputContract,
  generateFormatInstructions,
  renderFinalPrompt,
  FACTORY_OUTPUT_TAG,
  SCALAR_TYPES,
  outputDescriptorSchema,
  outputsMapSchema,
} from "./output-contract.js";
export type {
  OutputDescriptor,
  OutputsMap,
  ScalarType,
  FlatObjectDescriptor,
} from "./output-contract.js";

export {
  questionSchema,
  questionOptionSchema,
  answerSchema,
  QUESTION_KINDS,
  questionSchemaByKind,
  renderAnswerForAgent,
  renderQuestionForHuman,
  type Question,
  type QuestionKind,
  type QuestionOption,
  type Answer,
} from "../question.js";

export { KEY_PATTERN, isValidKey } from "./key.js";
export { DURATION_PATTERN, durationSchema, humanTimeoutSchema } from "./duration.js";

export { stepRunBranchName, type StepRunBranchInput } from "./step-run-branch.js";

export {
  joinManifestSchema,
  joinManifestEntrySchema,
  type JoinManifest,
  type JoinManifestEntry,
} from "./join-manifest.js";
