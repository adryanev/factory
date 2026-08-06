/**
 * The human-in-the-loop half (issue 13): the web surface that lists the
 * Questions a human is asked and records their answer. The Runner's surface
 * (`submitQuestion`) already moves a StepRun to `awaiting-human` **without a
 * lease**; this file is the other side of that state.
 *
 * Two guarantees carry over from the spec ("Step yang menunggu manusia"):
 *
 *  - **Jawaban pertama menang lewat compare-and-set.** The answering write is
 *    one conditional `UPDATE ... WHERE answered_at IS NULL (and the StepRun is
 *    still `awaiting-human`)`, so two humans answering the same Question at
 *    once cannot both win, and a Question on a StepRun that has since been
 *    cancelled or moved on cannot be answered either. Losing the race is
 *    *state, not error* (AC8): the loser gets the latest Question state plus
 *    their own typed answer back, and the typed text is not discarded.
 *
 *  - **Penolakan adalah data.** An `approved: false` Answer never fails
 *    anything by itself — it is rendered back to the agent as the prompt of
 *    the next turn (`resumePrompt`, via shared `renderAnswerForAgent`). What
 *    it does to the Graph is the Step's own `onReject: fail | continue`
 *    property, read here from the Run's definition snapshot (AC5).
 *
 * Answering advances the StepRun by *birth*, not overwrite: the answered
 * `awaiting-human` row goes `succeeded`, and a **new** StepRun row is born at
 * `turn + 1, attempt: 1`, `outcome: ready`, carrying the session (blob key +
 * id), the resume prompt, and the ref the previous turn pushed — two separate
 * numberings, and the retry policy reads `attempt` only (AC3). The new row is
 * claimed by any free Runner; the agent resumes from the persisted session
 * (AC1/AC2).
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  generateId,
  normalizeArtifactKey,
  renderAnswerForAgent,
  type Answer,
  type Id,
  type Question,
  type QuestionKind,
  type QuestionOption,
} from "@factory/shared";
import {
  artifacts,
  groupMembers,
  projects,
  questions,
  runs,
  stepRuns,
  stepRunUploadGrants,
} from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { Principal } from "./principal.js";
import { advanceGraph, finalizeRunIfDone, parsePipelineSnapshot } from "./graph-advance.js";
import { DomainValidationError, ForbiddenError, NotFoundError } from "./errors.js";
import { MAX_ARTIFACT_BYTES } from "./step-run-turn.js";

/** The latest readable state of a Question — what the web renders, and what a race loser is handed back (AC8). */
export interface QuestionState {
  id: Id<"question">;
  stepRunId: Id<"steprun">;
  groupId: Id<"group">;
  kind: QuestionKind;
  body: string;
  options?: QuestionOption[];
  multi?: boolean;
  allowOther?: boolean;
  artifactKey: string | null;
  createdAt: Date;
  answeredAt: Date | null;
  answeredByPrincipalId: Id<"user"> | null;
  answer: Answer | null;
  /** The owning StepRun's outcome — `awaiting-human` while open, anything else once it moved on. */
  stepRunOutcome: string;
  stepKey: string;
  branchKey: string | null;
  turn: number;
  runId: Id<"run">;
  projectId: Id<"project">;
  projectName: string;
}

export interface ArtifactEditUpload {
  key: string;
  contentType: "text/markdown";
  uploadUrl: string;
  blobKey: string;
  expiresAt: Date;
}

function toQuestionState(
  question: typeof questions.$inferSelect,
  stepRun: typeof stepRuns.$inferSelect,
  run: typeof runs.$inferSelect,
  project: typeof projects.$inferSelect,
): QuestionState {
  return {
    id: question.id,
    stepRunId: question.stepRunId,
    groupId: question.groupId,
    kind: question.kind,
    body: question.body,
    ...(question.options !== null ? { options: question.options } : {}),
    ...(question.multi !== null ? { multi: question.multi } : {}),
    ...(question.allowOther !== null ? { allowOther: question.allowOther } : {}),
    artifactKey: question.artifactKey,
    createdAt: question.createdAt,
    answeredAt: question.answeredAt,
    answeredByPrincipalId: question.answeredByPrincipalId,
    answer: question.answer,
    stepRunOutcome: stepRun.outcome,
    stepKey: stepRun.stepKey,
    branchKey: stepRun.branchKey,
    turn: stepRun.turn,
    runId: run.id,
    projectId: project.id,
    projectName: project.name,
  };
}

interface QuestionWithContext {
  question: typeof questions.$inferSelect;
  stepRun: typeof stepRuns.$inferSelect;
  run: typeof runs.$inferSelect;
  project: typeof projects.$inferSelect;
}

async function loadQuestionWithContext(
  db: AppDeps["db"],
  questionId: Id<"question">,
): Promise<QuestionWithContext | undefined> {
  const rows = await db
    .select({ question: questions, stepRun: stepRuns, run: runs, project: projects })
    .from(questions)
    .innerJoin(stepRuns, eq(stepRuns.id, questions.stepRunId))
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(questions.id, questionId));
  const row = rows[0];
  if (!row) return undefined;
  return row;
}

/** The `group_members` rows naming this principal — ServiceAccounts are never Group members (a Group contains Project members only). */
async function groupIdsOfPrincipal(
  db: AppDeps["db"],
  principal: Principal,
): Promise<Id<"group">[]> {
  if (principal.kind !== "user") {
    return [];
  }
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.principalId, principal.id));
  return rows.map((row) => row.groupId);
}

/** The "Menunggu saya" surface (issue 19, in-app badge): every open Question whose audience Group contains the caller. Cancelled runs vanish automatically — the predicate reads `step_runs.outcome = 'awaiting-human'`, never a stored flag. */
export async function listWaitingQuestions(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
): Promise<QuestionState[]> {
  const groupIds = await groupIdsOfPrincipal(deps.db, principal);
  if (groupIds.length === 0) {
    return [];
  }
  const rows = await deps.db
    .select({ question: questions, stepRun: stepRuns, run: runs, project: projects })
    .from(questions)
    .innerJoin(stepRuns, eq(stepRuns.id, questions.stepRunId))
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(
      and(
        isNull(questions.answeredAt),
        inArray(questions.groupId, groupIds),
        eq(stepRuns.outcome, "awaiting-human"),
      ),
    )
    .orderBy(asc(questions.createdAt));
  return rows.map((row) => toQuestionState(row.question, row.stepRun, row.run, row.project));
}

/**
 * The in-app badge is a read of the same open-Question state as the waiting
 * page. It deliberately counts rows instead of maintaining a counter; the
 * unanswered partial index on `questions.created_at` is the access path.
 */
export async function countWaitingQuestions(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
): Promise<number> {
  const groupIds = await groupIdsOfPrincipal(deps.db, principal);
  if (groupIds.length === 0) {
    return 0;
  }

  const [row] = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(questions)
    .innerJoin(stepRuns, eq(stepRuns.id, questions.stepRunId))
    .where(
      and(
        isNull(questions.answeredAt),
        inArray(questions.groupId, groupIds),
        eq(stepRuns.outcome, "awaiting-human"),
      ),
    );
  return row?.count ?? 0;
}

export type AnswerQuestionResult =
  | { status: "accepted" }
  | {
      status: "race-lost";
      /** The latest state of the Question the caller raced on — answered by someone else, or moved on without an answer. */
      question: QuestionState;
      /** The caller's own typed answer, returned so their text is never lost (AC8). */
      typedAnswer: Answer;
    };

/** Asserts the caller is a member of the Question's audience Group (AC6: a Question addresses a Group) and returns their `Id<"user">` for the answering write. */
async function requireGroupMember(
  db: AppDeps["db"],
  principal: Principal,
  groupId: Id<"group">,
): Promise<Id<"user">> {
  if (principal.kind !== "user") {
    throw new ForbiddenError(
      "forbidden_not_group_member",
      `only members of group ${groupId} may answer this Question`,
    );
  }
  const [row] = await db
    .select({ principalId: groupMembers.principalId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.principalId, principal.id)));
  if (!row) {
    throw new ForbiddenError(
      "forbidden_not_group_member",
      `only members of group ${groupId} may answer this Question`,
    );
  }
  return principal.id;
}

/**
 * Mints the browser's PUT for an inline draft edit. The existing Question
 * audience is the turn permission; there is no second editor lock. The grant
 * is held on the awaiting StepRun until its Question CAS commits.
 */
export async function mintArtifactEditUpload(
  deps: Pick<AppDeps, "db" | "objectStore" | "clock">,
  principal: Principal,
  questionId: Id<"question">,
  sizeBytes: number,
): Promise<ArtifactEditUpload> {
  const context = await loadQuestionWithContext(deps.db, questionId);
  if (!context) {
    throw new NotFoundError("question", questionId);
  }
  await requireGroupMember(deps.db, principal, context.question.groupId);
  if (context.question.kind !== "edit-artifact" || !context.question.artifactKey) {
    throw new DomainValidationError(
      "question_not_edit_artifact",
      "only an edit-artifact Question can receive a draft upload",
    );
  }
  if (context.stepRun.outcome !== "awaiting-human" || context.question.answeredAt !== null) {
    throw new DomainValidationError(
      "question_not_open",
      "the edit-artifact Question is no longer open",
    );
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_ARTIFACT_BYTES) {
    throw new DomainValidationError(
      "artifact_too_large",
      `the draft is ${sizeBytes} bytes, over the ${MAX_ARTIFACT_BYTES}-byte per-artifact quota`,
    );
  }

  const key = normalizeArtifactKey(context.question.artifactKey);
  // The question's StepRun is the only stable id available before the answer
  // births the next turn. The resulting Artifact still belongs to that new
  // StepRun; this key is only the immutable blob location minted for the PUT.
  const blobKey = `artifact/${context.stepRun.id}/${key}`;
  const { url, expiresAt } = await deps.objectStore.mintPutUrl(blobKey);
  await deps.db.transaction(async (tx) => {
    await tx
      .delete(stepRunUploadGrants)
      .where(
        and(
          eq(stepRunUploadGrants.stepRunId, context.stepRun.id),
          eq(stepRunUploadGrants.attempt, context.stepRun.attempt),
          eq(stepRunUploadGrants.kind, "artifact"),
        ),
      );
    await tx.insert(stepRunUploadGrants).values({
      stepRunId: context.stepRun.id,
      attempt: context.stepRun.attempt,
      key,
      kind: "artifact",
      sizeBytes,
      blobKey,
      grantedAt: deps.clock.now(),
    });
  });
  return { key, contentType: "text/markdown", uploadUrl: url, blobKey, expiresAt };
}

/** Rebuilds the closed Question from its stored columns — the `renderAnswerForAgent` input. */
export function questionFromRow(question: typeof questions.$inferSelect): Question {
  switch (question.kind) {
    case "choice":
      return {
        kind: "choice",
        body: question.body,
        options: question.options ?? [],
        multi: question.multi ?? false,
        allowOther: question.allowOther ?? false,
      };
    case "edit-artifact":
      return { kind: "edit-artifact", body: question.body, artifactKey: question.artifactKey ?? "" };
    case "approval":
      return { kind: "approval", body: question.body };
    case "text":
      return { kind: "text", body: question.body };
  }
}

/**
 * Records a human's answer. The compare-and-set is the single conditional
 * UPDATE — first answerer wins, and a Question whose StepRun is no longer
 * `awaiting-human` (cancelled, or its turn already superseded) is refused the
 * same way. On a loss the caller gets the latest state plus their own typed
 * answer back (`409` at the route; this function returns it as data).
 *
 * On a win, the answered `awaiting-human` row goes `succeeded` and a new
 * StepRun row is born at `turn + 1, attempt: 1` carrying the session and the
 * rendered answer as its resume prompt — unless the Step's `onReject: fail`
 * fired on an `approved: false` Approval, in which case the StepRun is failed
 * and the Graph advances (downstream skipped, Run finalised) in the same
 * transaction.
 */
export async function answerQuestion(
  deps: Pick<AppDeps, "db" | "clock">,
  principal: Principal,
  questionId: Id<"question">,
  answer: Answer,
): Promise<AnswerQuestionResult> {
  const context = await loadQuestionWithContext(deps.db, questionId);
  if (!context) {
    throw new NotFoundError("question", questionId);
  }
  const answeringUser = await requireGroupMember(deps.db, principal, context.question.groupId);

  if (answer.kind !== context.question.kind) {
    throw new DomainValidationError(
      "question_answer_kind_mismatch",
      `Question kind '${context.question.kind}' cannot be answered with '${answer.kind}'`,
    );
  }

  const now = deps.clock.now();
  const won = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(questions)
      .set({
        answeredAt: now,
        answeredByPrincipalId: answeringUser,
        answer,
      })
      .where(
        and(
          eq(questions.id, questionId),
          isNull(questions.answeredAt),
          // The question is answerable only while its StepRun is still
          // awaiting-human — a cancelled or already-superseded run is not.
          sql`exists (select 1 from step_runs sr where sr.id = ${questions.stepRunId} and sr.outcome = 'awaiting-human')`,
        ),
      )
      .returning({ id: questions.id });
    if (updated.length === 0) {
      return false;
    }

    const [run] = await tx.select().from(runs).where(eq(runs.id, context.stepRun.runId));
    if (!run) {
      return true; // a run row that vanished is not ours to fail on — the answer stands.
    }
    const pipeline = parsePipelineSnapshot(run.definition);
    const step = pipeline?.steps[context.stepRun.stepKey];

    const rejectedByProperty =
      answer.kind === "approval" && answer.approved === false && step?.onReject === "fail";

    if (rejectedByProperty) {
      // AC5: `onReject: fail` — the rejection is data, but this Step declares
      // that a human rejection ends it. The Graph advances from the failed
      // row in the same transaction.
      await tx
        .update(stepRuns)
        .set({ outcome: "failed", reason: "rejected-by-human" })
        .where(eq(stepRuns.id, context.stepRun.id));
      if (pipeline) {
        await advanceGraph({ db: tx, now: () => now }, run, pipeline, context.stepRun.stepKey);
        await finalizeRunIfDone({ db: tx, now: () => now }, run.id, pipeline);
      }
      return true;
    }

    // Continue: the answered row is terminal (its turn ended with an answered
    // Question), and a brand-new row is born for the next turn. Attempt resets
    // to 1 inside the new turn; retry policy reads `attempt` only (AC3).
    await tx
      .update(stepRuns)
      .set({ outcome: "succeeded" })
      .where(eq(stepRuns.id, context.stepRun.id));

    const resumePrompt = renderAnswerForAgent(questionFromRow(context.question), answer);

    const nextStepRunId = generateId("steprun");
    await tx.insert(stepRuns).values({
      id: nextStepRunId,
      runId: context.stepRun.runId,
      repositoryId: context.stepRun.repositoryId,
      stepKey: context.stepRun.stepKey,
      branchKey: context.stepRun.branchKey,
      turn: context.stepRun.turn + 1,
      attempt: 1,
      outcome: "ready",
      kind: context.stepRun.kind,
      requiredTags: context.stepRun.requiredTags,
      readyAt: now,
      // The conversation rides on: the session (blob + id) and the ref the
      // previous turn pushed, plus the human's answer as the resume prompt.
      sessionBlobKey: context.stepRun.sessionBlobKey,
      sessionId: context.stepRun.sessionId,
      resumePrompt,
      outputRefBranch: context.stepRun.outputRefBranch,
      outputRefSha: context.stepRun.outputRefSha,
    });

    if (answer.kind === "edit-artifact") {
      const [grant] = await tx
        .select()
        .from(stepRunUploadGrants)
        .where(
          and(
            eq(stepRunUploadGrants.stepRunId, context.stepRun.id),
            eq(stepRunUploadGrants.attempt, context.stepRun.attempt),
            eq(stepRunUploadGrants.kind, "artifact"),
            eq(stepRunUploadGrants.key, normalizeArtifactKey(context.question.artifactKey ?? "artifact")),
          ),
        );
      const sizeBytes = Buffer.byteLength(answer.content, "utf8");
      if (!grant) {
        throw new DomainValidationError(
          "artifact_edit_upload_required",
          "upload the edited artifact before answering the Question",
        );
      }
      if (sizeBytes > grant.sizeBytes) {
        throw new DomainValidationError(
          "artifact_size_exceeds_grant",
          `the edited artifact is ${sizeBytes} bytes but only ${grant.sizeBytes} was granted`,
        );
      }
      await tx.insert(artifacts).values({
        id: generateId("artifact"),
        stepRunId: nextStepRunId,
        key: grant.key,
        kind: "document",
        contentType: "text/markdown",
        blobKey: grant.blobKey,
        sizeBytes,
        authoredByPrincipalId: answeringUser,
        createdAt: now,
      });
    }
    await tx
      .delete(stepRunUploadGrants)
      .where(
        and(
          eq(stepRunUploadGrants.stepRunId, context.stepRun.id),
          eq(stepRunUploadGrants.attempt, context.stepRun.attempt),
        ),
      );
    return true;
  });

  if (!won) {
    const latest = await loadQuestionWithContext(deps.db, questionId);
    const state = latest ? toQuestionState(latest.question, latest.stepRun, latest.run, latest.project)
      : toQuestionState(context.question, context.stepRun, context.run, context.project);
    return {
      status: "race-lost",
      question: state,
      typedAnswer: answer,
    };
  }
  return { status: "accepted" };
}

/** One Question's latest state — for the web's read-after-race refresh. */
export async function getQuestion(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  questionId: Id<"question">,
): Promise<QuestionState> {
  const context = await loadQuestionWithContext(deps.db, questionId);
  if (!context) {
    throw new NotFoundError("question", questionId);
  }
  await requireGroupMember(deps.db, principal, context.question.groupId);
  return toQuestionState(context.question, context.stepRun, context.run, context.project);
}
