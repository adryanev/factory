export { validatePipelineDefinition } from "./validate.js";
export type { ValidationResult, ValidationIssue } from "./validate.js";

export { pipelineSchema, stepSchema, branchSchema, outputRefSchema, joinPolicySchema, askSchema } from "./schema.js";
export type { Pipeline, Step, Branch, OutputRef, JoinPolicy } from "./types.js";

export {
  compileOutputsSchema,
  compileStepOutputContract,
  generateFormatInstructions,
  questionSchema,
  FACTORY_OUTPUT_TAG,
  SCALAR_TYPES,
  QUESTION_KINDS,
  outputDescriptorSchema,
  outputsMapSchema,
} from "./output-contract.js";
export type {
  OutputDescriptor,
  OutputsMap,
  ScalarType,
  FlatObjectDescriptor,
  Question,
  QuestionKind,
} from "./output-contract.js";

export { KEY_PATTERN, isValidKey } from "./key.js";
export { DURATION_PATTERN, durationSchema, humanTimeoutSchema } from "./duration.js";

export { stepRunBranchName, type StepRunBranchInput } from "./step-run-branch.js";
