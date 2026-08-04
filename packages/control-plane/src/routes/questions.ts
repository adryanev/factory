/**
 * The web surface for the human-in-the-loop (issue 13): the "Menunggu saya"
 * list, one Question's state, and the answering write. A web-surface route
 * like `runs.ts` — session `Principal`, `camelCase` bodies, and no `db` reach;
 * every read/write goes through `deps.domain.questions`, which guards on the
 * caller's membership in the Question's audience Group.
 *
 * The answering write is a compare-and-set, and losing the race is state, not
 * error (AC8): this endpoint answers `409` with the latest Question state plus
 * the caller's own typed answer, so a loser's text is never discarded.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import {
  answerSchema,
  errorResponseSchema,
  type Answer,
  type Id,
} from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import type { QuestionState } from "../domain/step-run-questions.js";
import { requirePrincipal } from "./require-principal.js";

const questionIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const questionOptionSchema = z
  .object({ id: z.string(), label: z.string(), description: z.string().optional() })
  .openapi("QuestionOption");

const questionStateSchema = z
  .object({
    id: z.string(),
    stepRunId: z.string(),
    groupId: z.string(),
    kind: z.enum(["text", "choice", "approval", "edit-artifact"]),
    body: z.string(),
    options: z.array(questionOptionSchema).optional(),
    multi: z.boolean().optional(),
    allowOther: z.boolean().optional(),
    artifactKey: z.string().nullable(),
    createdAt: z.string(),
    answeredAt: z.string().nullable(),
    answeredByPrincipalId: z.string().nullable(),
    answer: z.unknown().nullable(),
    stepRunOutcome: z.string(),
    stepKey: z.string(),
    branchKey: z.string().nullable(),
    turn: z.number(),
    runId: z.string(),
    projectId: z.string(),
    projectName: z.string(),
  })
  .openapi("QuestionState");

function toQuestionStateResponse(state: QuestionState) {
  return {
    id: state.id,
    stepRunId: state.stepRunId,
    groupId: state.groupId,
    kind: state.kind,
    body: state.body,
    ...(state.options !== undefined ? { options: state.options } : {}),
    ...(state.multi !== undefined ? { multi: state.multi } : {}),
    ...(state.allowOther !== undefined ? { allowOther: state.allowOther } : {}),
    artifactKey: state.artifactKey,
    createdAt: state.createdAt.toISOString(),
    answeredAt: state.answeredAt?.toISOString() ?? null,
    answeredByPrincipalId: state.answeredByPrincipalId,
    answer: state.answer,
    stepRunOutcome: state.stepRunOutcome,
    stepKey: state.stepKey,
    branchKey: state.branchKey,
    turn: state.turn,
    runId: state.runId,
    projectId: state.projectId,
    projectName: state.projectName,
  };
}

const waitingRoute = createRoute({
  method: "get",
  path: "/questions/waiting",
  summary:
    "The 'Menunggu saya' list: every open Question whose audience Group contains the caller, oldest first (issue 19's badge is this same query). Cancelled runs vanish automatically.",
  responses: {
    200: {
      description: "Ok.",
      content: { "application/json": { schema: z.object({ questions: z.array(questionStateSchema) }) } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const getQuestionRoute = createRoute({
  method: "get",
  path: "/questions/{id}",
  summary: "One Question's latest state — the read a race-losing client uses to refresh.",
  request: { params: questionIdParamSchema },
  responses: {
    200: { description: "Ok.", content: { "application/json": { schema: questionStateSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a member of the Question's Group.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Question.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const answerRequestSchema = z
  .object({
    answer: answerSchema,
    /** The id of the Question the caller *believes* they are answering — when it has moved on, the server returns the latest state with this draft preserved. */
    expectedQuestionId: z.string().optional(),
  })
  .openapi("AnswerQuestionRequest");

const answerRoute = createRoute({
  method: "post",
  path: "/questions/{id}/answer",
  summary:
    "Records a human's answer, compare-and-set: first answer wins. `approved: false` is data — it is sent back to the agent as the next turn's prompt, and only a Step's `onReject: fail` fails the StepRun. Losing the race is 409 carrying the latest state plus your own typed answer, never discarded.",
  request: { params: questionIdParamSchema, body: { content: { "application/json": { schema: answerRequestSchema } } } },
  responses: {
    200: { description: "Accepted.", content: { "application/json": { schema: z.object({ status: z.literal("accepted") }) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a member of the Question's Group.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Question.", content: { "application/json": { schema: errorResponseSchema } } },
    409: {
      description: "Race lost: the Question was already answered, or its StepRun moved on. Body carries the latest state plus your typed answer.",
      content: {
        "application/json": {
          schema: z.object({
            code: z.literal("question_race_lost"),
            message: z.string(),
            question: questionStateSchema,
            typedAnswer: z.unknown(),
          }),
        },
      },
    },
  },
});

export function registerQuestionRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(waitingRoute, async (c) => {
    const principal = requirePrincipal(c);
    const questions = await deps.domain.questions.listWaiting(principal);
    return c.json({ questions: questions.map(toQuestionStateResponse) }, 200);
  });

  app.openapi(getQuestionRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const state = await deps.domain.questions.get(principal, id as Id<"question">);
    return c.json(toQuestionStateResponse(state), 200);
  });

  app.openapi(answerRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { answer } = c.req.valid("json");
    const result = await deps.domain.questions.answer(principal, id as Id<"question">, answer as Answer);
    if (result.status === "accepted") {
      return c.json({ status: "accepted" as const }, 200);
    }
    return c.json(
      {
        code: "question_race_lost" as const,
        message: "this Question was already answered, or its StepRun has moved on",
        question: toQuestionStateResponse(result.question),
        typedAnswer: result.typedAnswer,
      },
      409,
    );
  });
}
