import { z } from "zod";
import { KEY_PATTERN, KEY_PATTERN_DESCRIPTION } from "./key.js";
import { durationSchema, humanTimeoutSchema } from "./duration.js";
import { outputsMapSchema, QUESTION_KINDS } from "./output-contract.js";
import { isValidCronExpression } from "./cron.js";

/**
 * The Pipeline definition schema (spec.md, "Definisi Pipeline").
 *
 * Pure data, no expressions. Everything YAML itself cannot enforce (XOR
 * clauses, cross-references, acyclicity) is enforced in the single
 * `superRefine` at the bottom of this file, with every issue carrying an
 * explicit `path` so the caller (validate.ts) can point the error at a line.
 */

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

/** A reference to another Step's Output — data, never a parsed string. */
export const outputRefSchema = z.object({
  step: z.string().min(1),
  output: z.string().min(1),
});

export const joinPolicySchema = z.union([
  z.literal("all"),
  z.literal("any"),
  z.object({ min: z.number().int().positive() }),
]);

export const askSchema = z.object({
  group: z.string().min(1),
  kind: z.enum(QUESTION_KINDS),
});

export const onRejectSchema = z.enum(["fail", "continue"]).default("continue");
export const onHumanTimeoutSchema = z.enum(["fail", "continue"]);

const keySchema = z
  .string()
  .regex(KEY_PATTERN, `Key ${KEY_PATTERN_DESCRIPTION}`);

// ---------------------------------------------------------------------------
// `on:` — the Automation trigger block (issue #18, spec: "Automation").
// ---------------------------------------------------------------------------

export const cronExpressionSchema = z
  .string()
  .refine(isValidCronExpression, {
    message: "not a valid 5-field cron expression (minute hour day-of-month month day-of-week)",
  });

/**
 * `on: { push: ... }` — the push filters. `branches:`/`paths:` use the
 * whole-value wildcard language of `glob.ts` (`*`, `**`, `?`); `repos:`
 * names other Repositories of the same Project and is what makes a Pipeline
 * **lintas repo** (cross-repo): when one of those Repositories gets a push,
 * this Pipeline is read from the default branch of its own host Repository
 * and triggered over the pushed ref (ticket 22, "Pemetaan kejadian →
 * Pipeline").
 */
export const onPushSchema = z.object({
  branches: z.array(z.string().min(1)).optional(),
  paths: z.array(z.string().min(1)).optional(),
  repos: z.array(z.string().min(1)).optional(),
});

export const onSchema = z
  .object({
    push: onPushSchema.optional(),
    pullRequest: z.boolean().optional(),
    schedule: z.array(cronExpressionSchema).optional(),
  })
  .refine(
    (on) => on.push !== undefined || on.pullRequest === true || (on.schedule?.length ?? 0) > 0,
    {
      message: "on: must declare at least one trigger — push:, pullRequest: true, or a non-empty schedule:.",
    },
  );

export type RawOn = z.infer<typeof onSchema>;

// ---------------------------------------------------------------------------
// Branch (an element of `branches:`) — a full Step, minus the fields that
// only make sense at the fan-out point itself (after, branches/branchesFrom,
// minBranches, join, ask/HITL, kind). "Cabang adalah daftar Step utuh":
// unset fields fall back to the parent Step's value (see effectiveBranch()).
// ---------------------------------------------------------------------------

export const branchSchema = z.object({
  key: keySchema,
  repo: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  run: z.string().min(1).optional(),
  runsOn: z.array(z.string().min(1)).min(1).optional(),
  timeout: durationSchema.optional(),
  attempts: z.number().int().positive().optional(),
  outputs: outputsMapSchema.optional(),
});

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

export const stepSchema = z.object({
  after: z.array(z.string().min(1)).default([]),
  repo: z.string().min(1).optional(),

  // Agent-executed
  promptFile: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  outputs: outputsMapSchema.optional(),

  // Shell-executed
  run: z.string().min(1).optional(),

  runsOn: z.array(z.string().min(1)).min(1).optional(),
  timeout: durationSchema.optional(),
  // No default on purpose: "timeout:/attempts: are rejected on a Step with
  // kind:" must tell an omitted field apart from an explicitly written one.
  // The runtime default (2) is applied outside the validator.
  attempts: z.number().int().positive().optional(),

  // Fan-out
  branches: z.array(branchSchema).min(1).optional(),
  branchesFrom: outputRefSchema.optional(),
  // Default 1 closes the "all over an empty set is true" trap; 0 is the
  // explicit opt-out a Pipeline whose fan-out may legally produce nothing
  // writes (ticket 06). `.nonnegative()`, not `.positive()`, on purpose.
  minBranches: z.number().int().nonnegative().default(1),

  // Join. Optional — no default on purpose: the *presence* of an explicit
  // `join:` is a fact the validator and the Graph advance both read. A Step
  // that writes `join:` is a Join; a Step that omits it follows its `after:`
  // one-for-one — and for a `kind:` Step the difference decides "born once
  // per branch" vs "born once" (issue #17). The "all" default for a plain
  // Join is applied at the runtime call site (`join ?? "all"`), never here.
  join: joinPolicySchema.optional(),

  // Human-in-the-loop
  ask: askSchema.optional(),
  onReject: onRejectSchema,
  humanTimeout: humanTimeoutSchema.default("none"),
  onHumanTimeout: onHumanTimeoutSchema.optional(),

  // Control-plane step (never claimed by a Runner)
  kind: z.literal("pull-request").optional(),
  base: z.string().min(1).optional(),
  title: outputRefSchema.optional(),
  body: outputRefSchema.optional(),
});

export type RawStep = z.infer<typeof stepSchema>;
export type RawBranch = z.infer<typeof branchSchema>;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const pipelineShapeSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  repo: z.string().min(1),
  // Automation triggers (issue #18). A Pipeline without `on:` is
  // manual-trigger-only — automation reads this block, never anything else.
  on: onSchema.optional(),
  unschedulableAfter: durationSchema.optional(),
  // No default on purpose: the "ask: requires concurrency:" rule below must
  // tell an omitted field apart from an explicitly written one. `cancel`
  // (the built-in default) is applied at the automation trigger site, never
  // here — the same reason the join: default lives at its runtime call site.
  concurrency: z.enum(["cancel", "queue"]).optional(),
  steps: z
    .record(z.string().min(1), stepSchema)
    .refine((steps) => Object.keys(steps).length > 0, {
      message: "a Pipeline must declare at least one Step.",
    }),
});

export type RawPipeline = z.infer<typeof pipelineShapeSchema>;

// ---------------------------------------------------------------------------
// Cross-field rules — everything YAML does not enforce.
// ---------------------------------------------------------------------------

const INHERITABLE_BRANCH_FIELDS = [
  "repo",
  "promptFile",
  "prompt",
  "agent",
  "run",
  "runsOn",
  "timeout",
  "attempts",
  "outputs",
] as const;

/** A Branch inherits any field it does not set from its parent Step. */
function effectiveBranch(step: RawStep, branch: RawBranch): Partial<RawStep> {
  const effective: Partial<RawStep> = {};
  for (const field of INHERITABLE_BRANCH_FIELDS) {
    const branchValue = branch[field];
    (effective as Record<string, unknown>)[field] =
      branchValue !== undefined ? branchValue : step[field];
  }
  return effective;
}

/**
 * The Step a StepRun actually executes. A non-fan-out StepRun (`branch_key`
 * NULL) resolves to its Step as written. A fan-out branch StepRun
 * (`branch_key` set) resolves to the fan-out Step's own fields merged with
 * the Branch's overrides — "cabang adalah daftar Step utuh" (spec.md,
 * "Definisi Pipeline"): prompt/agent/repo/runsOn/... fall back to the
 * parent, and the branch-only fields (`after`, `branches`, `join`, `ask`,
 * `kind`) always come from the parent. For a `branchesFrom:` fan-out the
 * Branch entries carry runtime data, not definition fields, so every branch
 * resolves to the parent Step unchanged.
 *
 * Shared by the Runner (to execute the branch) and the control plane (to
 * pin the final prompt and resolve `ask.group` at claim) so the effective
 * Step cannot differ between the two sides.
 */
export function resolveEffectiveStep(
  pipeline: Pick<Pipeline, "steps">,
  stepKey: string,
  branchKey: string | null | undefined,
): RawStep | undefined {
  const step = pipeline.steps[stepKey];
  if (!step) return undefined;
  if (branchKey === null || branchKey === undefined) return step;
  const branch = step.branches?.find((b) => b.key === branchKey);
  if (!branch) return step; // a branchesFrom branch: no definition entry — the parent Step is the whole story.
  const effective: Partial<RawStep> = effectiveBranch(step, branch);
  return { ...step, ...effective };
}

interface ExecutionModeSource {
  prompt?: string | undefined;
  promptFile?: string | undefined;
  run?: string | undefined;
  kind?: "pull-request" | undefined;
  outputs?: unknown;
}

/**
 * Enforces: `prompt:` XOR `promptFile:`; `agent:`/`prompt:`/`promptFile:`
 * XOR `run:`; `outputs:` only for a Step that has an agent. Shared between
 * top-level Steps and Branches (a Branch is a full Step).
 */
function checkExecutionMode(
  node: ExecutionModeSource,
  path: (string | number)[],
  ctx: z.RefinementCtx
): void {
  const hasPrompt = node.prompt !== undefined;
  const hasPromptFile = node.promptFile !== undefined;
  const hasRun = node.run !== undefined;
  const hasKind = node.kind !== undefined;
  const isAgentMode = hasPrompt || hasPromptFile;

  if (hasPrompt && hasPromptFile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "prompt"],
      message: "'prompt:' and 'promptFile:' are mutually exclusive; declare exactly one.",
    });
  }

  const activeModes = [isAgentMode, hasRun, hasKind].filter(Boolean).length;
  if (activeModes === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message:
        "a Step must declare exactly one of prompt:/promptFile:, run:, or kind: — none was found.",
    });
  } else if (activeModes > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message:
        "a Step must declare exactly one of prompt:/promptFile:/agent:, run:, or kind: — more than one was found.",
    });
  }

  if (node.outputs !== undefined && !isAgentMode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "outputs"],
      message:
        "'outputs:' is only valid on a Step with an agent (prompt: or promptFile:); it is rejected here because this Step uses run: or kind:.",
    });
  }
}

/** A Step is a fan-out source iff it fans out at all — constants or a dynamic list. */
function isFanOutNode(step: RawStep): boolean {
  return step.branches !== undefined || step.branchesFrom !== undefined;
}

/** DFS cycle detection over `after:` edges. Returns the first cycle found. */
function findCycle(steps: Record<string, RawStep>): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = in progress, 2 = done
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    state.set(id, 1);
    stack.push(id);
    // `id` always keys `steps`: callers pass either an `Object.keys(steps)`
    // entry or a `dep` already confirmed `in steps` below.
    for (const dep of steps[id]!.after) {
      if (!(dep in steps)) continue; // reported separately: unknown after: id
      const depState = state.get(dep);
      if (depState === 1) {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      if (depState === undefined) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  }

  for (const id of Object.keys(steps)) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function checkBranches(
  stepId: string,
  step: RawStep,
  ctx: z.RefinementCtx
): void {
  if (!step.branches) return;
  const stepPath = ["steps", stepId];

  const seenKeys = new Map<string, number>();
  step.branches.forEach((branch, idx) => {
    const firstIdx = seenKeys.get(branch.key);
    if (firstIdx !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...stepPath, "branches", idx, "key"],
        message: `duplicate Key '${branch.key}' — also used by branches[${firstIdx}]. Keys must be unique within branches:.`,
      });
    } else {
      seenKeys.set(branch.key, idx);
    }

    checkExecutionMode(
      effectiveBranch(step, branch),
      [...stepPath, "branches", idx],
      ctx
    );
  });
}

function checkBranchesFrom(
  stepId: string,
  step: RawStep,
  steps: Record<string, RawStep>,
  ctx: z.RefinementCtx
): void {
  if (!step.branchesFrom) return;
  const stepPath = ["steps", stepId];
  const { step: sourceId, output: outputName } = step.branchesFrom;

  const sourceStep = steps[sourceId];
  if (!sourceStep) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...stepPath, "branchesFrom", "step"],
      message: `branchesFrom.step '${sourceId}' does not refer to a Step in this Pipeline.`,
    });
    return;
  }

  const descriptor = sourceStep.outputs?.[outputName];
  if (!descriptor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...stepPath, "branchesFrom", "output"],
      message: `Step '${sourceId}' has no output named '${outputName}'. The source Step of a branchesFrom must declare outputs:.`,
    });
    return;
  }

  const isArrayOfObjectWithStringKey =
    descriptor.type === "array" &&
    typeof descriptor.items === "object" &&
    descriptor.items.key === "string";

  if (!isArrayOfObjectWithStringKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...stepPath, "branchesFrom"],
      message: `branchesFrom source output '${sourceId}.${outputName}' must be type: array with items: a flat object containing key: string.`,
    });
  }
}

export const pipelineSchema = pipelineShapeSchema.superRefine((pipeline, ctx) => {
  const { steps } = pipeline;

  // Rule: `branches:` XOR `branchesFrom:`.
  for (const [id, step] of Object.entries(steps)) {
    if (step.branches !== undefined && step.branchesFrom !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", id],
        message: "'branches:' and 'branchesFrom:' are mutually exclusive; declare at most one.",
      });
    }
  }

  // Rule: agent:/prompt:/promptFile: XOR run:; prompt: XOR promptFile:;
  // outputs: only for a Step with an agent. Applied to each top-level Step.
  for (const [id, step] of Object.entries(steps)) {
    checkExecutionMode(step, ["steps", id], ctx);
  }

  // Rule: Keys unique within branches:, and the same execution-mode rules
  // applied to each Branch's *effective* (merged with parent) fields.
  for (const [id, step] of Object.entries(steps)) {
    checkBranches(id, step, ctx);
  }

  // Rule: the source Step of a branchesFrom must have outputs: of type
  // array-of-object containing key: string.
  for (const [id, step] of Object.entries(steps)) {
    checkBranchesFrom(id, step, steps, ctx);
  }

  // Rule: after: points at ids that exist; after: pointing at a kind:
  // Step is an error (it is a leaf).
  for (const [id, step] of Object.entries(steps)) {
    step.after.forEach((depId, idx) => {
      const dep = steps[depId];
      if (!dep) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", id, "after", idx],
          message: `after: refers to unknown Step id '${depId}'.`,
        });
        return;
      }
      if (dep.kind !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", id, "after", idx],
          message: `after: cannot depend on '${depId}' — a kind: Step is a leaf; nothing may declare it as a dependency.`,
        });
      }
    });
  }

  // Rule: the Graph is acyclic.
  const cycle = findCycle(steps);
  if (cycle) {
    // A cycle is at least [id, id] (length 2), so index `length - 2` always exists.
    const closingStepId = cycle[cycle.length - 2]!;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps", closingStepId, "after"],
      message: `cyclic dependency: ${cycle.join(" -> ")}.`,
    });
  }

  // Rule: onHumanTimeout: is meaningful only when humanTimeout: is not none.
  for (const [id, step] of Object.entries(steps)) {
    if (step.onHumanTimeout !== undefined && step.humanTimeout === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", id, "onHumanTimeout"],
        message:
          "onHumanTimeout: is only meaningful when humanTimeout: is set to something other than 'none'.",
      });
    }
  }

  // Rule: timeout:/attempts: are rejected on a Step with kind:.
  for (const [id, step] of Object.entries(steps)) {
    if (step.kind === undefined) continue;
    if (step.timeout !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", id, "timeout"],
        message: "timeout: is rejected on a Step with kind: — control-plane Steps use a fixed system timeout.",
      });
    }
    if (step.attempts !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps", id, "attempts"],
        message: "attempts: is rejected on a Step with kind: — control-plane Steps use a fixed system retry count.",
      });
    }
  }

  // Rule: a Step with kind: is a closed kind with a fixed shape. The whole
  // author-written execution surface is rejected — its numbers, its repo, its
  // fan-out, its scheduling, its human-in-the-loop fields, and its Outputs are
  // all owned by the kind, not the author (issue #17, ticket 24).
  for (const [id, step] of Object.entries(steps)) {
    if (step.kind === undefined) continue;
    const kindPath = ["steps", id];
    if (step.repo !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "repo"],
        message:
          "repo: is rejected on a Step with kind: — it inherits the repo of the branch it follows (issue #17).",
      });
    }
    if (step.branches !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "branches"],
        message: "branches: is rejected on a Step with kind: — a control-plane Step cannot fan out.",
      });
    }
    if (step.branchesFrom !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "branchesFrom"],
        message: "branchesFrom: is rejected on a Step with kind: — a control-plane Step cannot fan out.",
      });
    }
    if (step.runsOn !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "runsOn"],
        message: "runsOn: is rejected on a Step with kind: — it never runs on a Runner.",
      });
    }
    if (step.ask !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "ask"],
        message: "ask: is rejected on a Step with kind: — control-plane Steps are not interactive.",
      });
    }
    // onReject:/humanTimeout: carry schema defaults ("continue" / "none"), so
    // their *presence* is not observable — only a non-default write is. The
    // defaults are no-ops for a non-interactive Step, which is exactly why a
    // kind: Step may keep them.
    if (step.onReject !== undefined && step.onReject !== "continue") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "onReject"],
        message: "onReject: is rejected on a Step with kind: — control-plane Steps are not interactive.",
      });
    }
    if (step.humanTimeout !== undefined && step.humanTimeout !== "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "humanTimeout"],
        message: "humanTimeout: is rejected on a Step with kind: — control-plane Steps are not interactive.",
      });
    }
    if (step.onHumanTimeout !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "onHumanTimeout"],
        message: "onHumanTimeout: is rejected on a Step with kind: — control-plane Steps are not interactive.",
      });
    }
    // after: is what names the head branch the PR opens from ("ia yang memberi
    // Ref — branch mana yang jadi kepala PR", ticket 24) — exactly one, so the
    // head branch is never ambiguous. For a fan-out dep, the PR is born once
    // per branch; for a plain dep, once.
    if (step.after.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "after"],
        message:
          "a Step with kind: must declare exactly one after: entry — it is the branch the pull-request follows; more than one would make the head branch ambiguous.",
      });
    }
    // title:/body: are required and explicit — the PR's title and body come
    // from an upstream Step's Output, never inferred from after: (ticket 23/24:
    // an implicit form would be ambiguous on a Join).
    if (step.title === undefined || step.body === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "title"],
        message:
          "a Step with kind: must declare title: and body: as explicit { step, output } references — they are never inferred from after:.",
      });
    }
    // A fan-out dep with an explicit join: would make the head branch
    // ambiguous (which branch's PR?) — per-branch birth is the only supported
    // shape. The schema-level join: absence vs presence is exactly the flag
    // the advance reads ("Lahir sekali per cabang bila tanpa join:", AC3).
    const dep = steps[step.after[0]!];
    if (dep !== undefined && isFanOutNode(dep) && step.join !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "join"],
        message:
          "join: is rejected on a Step with kind: that follows a fan-out — it is born once per branch, and the head branch would be ambiguous on a Join.",
      });
    }
  }

  // Rule: kind-only fields (base:/title:/body:) are rejected on a Step that
  // is not kind: — the schema would otherwise strip them silently.
  for (const [id, step] of Object.entries(steps)) {
    if (step.kind !== undefined) continue;
    const kindPath = ["steps", id];
    if (step.base !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "base"],
        message: "base: is only valid on a Step with kind: pull-request.",
      });
    }
    if (step.title !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "title"],
        message: "title: is only valid on a Step with kind: pull-request.",
      });
    }
    if (step.body !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...kindPath, "body"],
        message: "body: is only valid on a Step with kind: pull-request.",
      });
    }
  }

  // Rule: the { step, output } references a kind: Step's title:/body: name must
  // resolve — the Step exists and declares that Output as a string (the PR's
  // title/body are text; ticket 23 locked the consumption side of this).
  for (const [id, step] of Object.entries(steps)) {
    if (step.kind === undefined) continue;
    for (const [field, ref] of [
      ["title", step.title],
      ["body", step.body],
    ] as const) {
      if (ref === undefined) continue;
      const source = steps[ref.step];
      if (!source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", id, field, "step"],
          message: `${field}.step '${ref.step}' does not refer to a Step in this Pipeline.`,
        });
        continue;
      }
      const descriptor = source.outputs?.[ref.output];
      if (!descriptor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", id, field, "output"],
          message: `Step '${ref.step}' has no output named '${ref.output}'. The ${field} of a pull-request Step must reference a declared Output.`,
        });
        continue;
      }
      if (descriptor.type !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", id, field],
          message: `Step '${ref.step}' declares output '${ref.output}' as ${descriptor.type}; the ${field} of a pull-request Step must be type: string.`,
        });
      }
    }
  }

  // Rule: a Join downstream of a repo-valued fan-out must write an explicit
  // repo:. A repo-valued fan-out is a `branches:` list where at least one
  // Branch overrides repo:. kind: Steps are excluded: they fan out once per
  // Branch themselves (inheriting repo per Branch) rather than joining.
  const repoValuedSources = new Set<string>();
  for (const [id, step] of Object.entries(steps)) {
    if (step.branches?.some((branch) => branch.repo !== undefined)) {
      repoValuedSources.add(id);
    }
  }
  for (const [id, step] of Object.entries(steps)) {
    if (step.kind !== undefined) continue;
    for (const depId of step.after) {
      if (repoValuedSources.has(depId) && step.repo === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", id],
          message: `Step '${id}' joins the repo-valued fan-out of '${depId}' and must declare repo: explicitly.`,
        });
      }
    }
  }

  // Rule: a Pipeline containing ask: must write concurrency: explicitly.
  if (pipeline.concurrency === undefined) {
    for (const [id, step] of Object.entries(steps)) {
      if (step.ask !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", id, "ask"],
          message:
            "this Pipeline has an interactive Step (ask:) and must declare concurrency: explicitly at the Pipeline level; the default cannot silently disable the human-in-the-loop mechanic.",
        });
        break;
      }
    }
  }
});

export type Pipeline = z.infer<typeof pipelineSchema>;
