export type { Pipeline, RawStep as Step, RawBranch as Branch } from "./schema.js";
export type { OutputDescriptor, OutputsMap, ScalarType, FlatObjectDescriptor, Question, QuestionKind } from "./output-contract.js";

/** A statically resolvable reference to an upstream Step's Output field. */
export interface OutputRef {
  step: string;
  output: string;
}

/** The policy a Join Step evaluates its upstream StepRuns against. */
export type JoinPolicy = "all" | "any" | { min: number };
