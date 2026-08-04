/**
 * The Runner, faked as an ordinary HTTP client speaking the nine Runner-
 * protocol endpoints — never a mocked object (spec: "Testing Decisions",
 * Seam 1, verbatim). Every method here does exactly what a real Runner's
 * HTTP layer would do: set `Authorization: Bearer <secret>`, send the
 * spec's own `snake_case` body shape, and hand back the raw status + parsed
 * body so a test can assert on both.
 */
export interface RunnerHttpResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

async function postRunner<T = unknown>(
  baseUrl: string,
  path: string,
  secret: string | undefined,
  body: unknown,
): Promise<RunnerHttpResult<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T, headers: response.headers };
}

export function createRunnerClient(baseUrl: string) {
  return {
    join: (token: string) => postRunner<{ runner_id: string; secret: string }>(baseUrl, "/join", undefined, { token }),

    claim: (
      secret: string,
      input: { tags?: string[]; slots?: number; protocol_version?: number } = {},
    ) =>
      postRunner<{ step_run: unknown }>(baseUrl, "/claim", secret, {
        tags: input.tags ?? [],
        slots: input.slots ?? 10,
        protocol_version: input.protocol_version ?? 1,
      }),

    heartbeat: (
      secret: string,
      input: { leases?: { step_run_id: string; lease_token: string }[]; caps_hash?: string | null } = {},
    ) =>
      postRunner<{
        desired_state: string;
        cancel: string[];
        unknown_leases: string[];
        caps_stale: boolean;
        latest_release: string;
        protocol: { min: number; max: number };
      }>(baseUrl, "/heartbeat", secret, { leases: input.leases ?? [], caps_hash: input.caps_hash ?? null }),

    reportCapabilities: (secret: string, input: { caps_hash: string; capabilities: unknown; release_version?: string }) =>
      postRunner<{ ok: true }>(baseUrl, "/runners/me/capabilities", secret, input),

    selfDrain: (secret: string) => postRunner<{ ok: true }>(baseUrl, "/runners/me/drain", secret, {}),

    uploads: (
      secret: string,
      stepRunId: string,
      input: { lease_token: string; requests: { key: string; kind: "artifact" | "session" }[] },
    ) => postRunner<{ grants: { key: string; upload_url: string; expires_at: string }[] }>(
      baseUrl,
      `/step-runs/${stepRunId}/uploads`,
      secret,
      input,
    ),

    logChunks: (
      secret: string,
      stepRunId: string,
      input: {
        lease_token: string;
        chunks: { attempt: number; seq: number; blob_key: string; byte_offset: number; size: number }[];
      },
    ) => postRunner<{ ok: true }>(baseUrl, `/step-runs/${stepRunId}/log-chunks`, secret, input),

    question: (
      secret: string,
      stepRunId: string,
      input: {
        lease_token: string;
        question: {
          id: string;
          group_id: string;
          kind: "text" | "choice" | "approval" | "edit-artifact";
          body: string;
          options?: { id: string; label: string; description?: string }[];
          multi?: boolean;
          allow_other?: boolean;
          artifact_key?: string;
        };
        ref: { branch: string; sha: string };
        session_blob_key?: string;
      },
    ) => postRunner<{ question_id: string }>(baseUrl, `/step-runs/${stepRunId}/question`, secret, input),

    result: (
      secret: string,
      stepRunId: string,
      input: {
        lease_token: string;
        outcome: "succeeded" | "failed";
        ref?: { branch: string; sha: string };
        output_data?: unknown;
        reason?: string;
      },
    ) => postRunner<{ outcome: string; ref: unknown; output_data: unknown }>(
      baseUrl,
      `/step-runs/${stepRunId}/result`,
      secret,
      input,
    ),
  };
}

export type RunnerClient = ReturnType<typeof createRunnerClient>;
