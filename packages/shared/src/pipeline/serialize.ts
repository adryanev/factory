import { stringify } from "yaml";
import type { Pipeline } from "./schema.js";

/**
 * Serializes a parsed `Pipeline` back to the YAML wire form (issue #20: the
 * visual editor's only direction is visual → code, and the PR it opens must
 * contain the same YAML shape the control plane parses at trigger time).
 *
 * This is the mirror of `validatePipelineDefinition`: validation parses YAML
 * text → `Pipeline`; this turns `Pipeline` → YAML text. The round trip is
 * stable — serialize → validate → serialize produces byte-identical text —
 * so an editor can hand-hold a `Pipeline` object and get deterministic
 * output, and a fixture that validates today keeps validating tomorrow.
 *
 * Schema defaults are omitted, not written: `after: []`, `minBranches: 1`,
 * `onReject: continue`, and `humanTimeout: none` are the parsed pipeline's
 * values whether or not the author wrote them, so emitting them would add
 * noise without changing meaning. Every non-default field is emitted with a
 * fixed key order so the output does not depend on object iteration order.
 */

interface OutputDescriptorSource {
  type: string;
  items?: unknown;
  description?: string;
}

interface StepSource {
  after: string[];
  repo?: string;
  promptFile?: string;
  prompt?: string;
  agent?: string;
  outputs?: Record<string, OutputDescriptorSource>;
  run?: string;
  runsOn?: string[];
  timeout?: string;
  attempts?: number;
  branches?: BranchSource[];
  branchesFrom?: { step: string; output: string };
  minBranches: number;
  join?: unknown;
  ask?: { group: string; kind: string };
  onReject: string;
  humanTimeout: string;
  onHumanTimeout?: string;
  kind?: "pull-request";
  base?: string;
  title?: { step: string; output: string };
  body?: { step: string; output: string };
}

interface BranchSource {
  key: string;
  repo?: string;
  promptFile?: string;
  prompt?: string;
  agent?: string;
  run?: string;
  runsOn?: string[];
  timeout?: string;
  attempts?: number;
  outputs?: Record<string, OutputDescriptorSource>;
}

interface PipelineSource {
  version: 1;
  name: string;
  repo: string;
  unschedulableAfter?: string;
  concurrency?: string;
  steps: Record<string, Record<string, unknown>>;
}

function branchToPlain(branch: BranchSource): Record<string, unknown> {
  const out: Record<string, unknown> = { key: branch.key };
  if (branch.repo !== undefined) out.repo = branch.repo;
  if (branch.promptFile !== undefined) out.promptFile = branch.promptFile;
  if (branch.prompt !== undefined) out.prompt = branch.prompt;
  if (branch.agent !== undefined) out.agent = branch.agent;
  if (branch.run !== undefined) out.run = branch.run;
  if (branch.runsOn !== undefined) out.runsOn = branch.runsOn;
  if (branch.timeout !== undefined) out.timeout = branch.timeout;
  if (branch.attempts !== undefined) out.attempts = branch.attempts;
  if (branch.outputs !== undefined) out.outputs = outputsToPlain(branch.outputs);
  return out;
}

function outputsToPlain(outputs: Record<string, OutputDescriptorSource>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, descriptor] of Object.entries(outputs)) {
    const plain: Record<string, unknown> = { type: descriptor.type };
    if (descriptor.items !== undefined) plain.items = descriptor.items;
    if (descriptor.description !== undefined) plain.description = descriptor.description;
    out[name] = plain;
  }
  return out;
}

function stepToPlain(step: StepSource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (step.after.length > 0) out.after = step.after;
  if (step.repo !== undefined) out.repo = step.repo;
  if (step.promptFile !== undefined) out.promptFile = step.promptFile;
  if (step.prompt !== undefined) out.prompt = step.prompt;
  if (step.agent !== undefined) out.agent = step.agent;
  if (step.outputs !== undefined) out.outputs = outputsToPlain(step.outputs);
  if (step.run !== undefined) out.run = step.run;
  if (step.runsOn !== undefined) out.runsOn = step.runsOn;
  if (step.timeout !== undefined) out.timeout = step.timeout;
  if (step.attempts !== undefined) out.attempts = step.attempts;
  if (step.branches !== undefined) out.branches = step.branches.map(branchToPlain);
  if (step.branchesFrom !== undefined) out.branchesFrom = step.branchesFrom;
  if (step.minBranches !== 1) out.minBranches = step.minBranches;
  if (step.join !== undefined) out.join = step.join;
  if (step.ask !== undefined) out.ask = step.ask;
  if (step.onReject !== "continue") out.onReject = step.onReject;
  if (step.humanTimeout !== "none") out.humanTimeout = step.humanTimeout;
  if (step.onHumanTimeout !== undefined) out.onHumanTimeout = step.onHumanTimeout;
  if (step.kind !== undefined) out.kind = step.kind;
  if (step.base !== undefined) out.base = step.base;
  if (step.title !== undefined) out.title = step.title;
  if (step.body !== undefined) out.body = step.body;
  return out;
}

export function serializePipeline(pipeline: Pipeline): string {
  const source: PipelineSource = {
    version: 1,
    name: pipeline.name,
    repo: pipeline.repo,
    ...(pipeline.unschedulableAfter !== undefined ? { unschedulableAfter: pipeline.unschedulableAfter } : {}),
    ...(pipeline.concurrency !== undefined ? { concurrency: pipeline.concurrency } : {}),
    steps: {},
  };
  for (const [key, step] of Object.entries(pipeline.steps)) {
    source.steps[key] = stepToPlain(step as unknown as StepSource);
  }
  return `${stringify(source as unknown as Record<string, unknown>)}`;
}
