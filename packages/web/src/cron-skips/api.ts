/**
 * The "cron yang dilewati" surface (issue 18, AC: "pelewatannya terlihat di
 * UI") — the visible half of "skip saat tumpang tindih". Consumes
 * GET /projects/{id}/automation/cron-skips (keyset on id DESC).
 */
export interface CronSkipRecord {
  id: string;
  projectId: string;
  pipelineRepositoryId: string;
  pipelinePath: string;
  refBranch: string;
  refSha: string;
  scheduledFor: string;
  skippedAt: string;
  reason: "run-active";
}

export interface CronSkipsPage {
  skips: CronSkipRecord[];
  nextCursor: string | null;
}

export async function fetchCronSkips(projectId: string, cursor?: string): Promise<CronSkipsPage> {
  const query = new URLSearchParams();
  if (cursor !== undefined) {
    query.set("cursor", cursor);
  }
  const queryString = query.toString();
  const response = await fetch(
    `/projects/${encodeURIComponent(projectId)}/automation/cron-skips${queryString ? `?${queryString}` : ""}`,
  );
  if (!response.ok) {
    throw new Error(`request failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  const body = text ? (JSON.parse(text) as CronSkipsPage) : undefined;
  if (body?.skips === undefined) {
    throw new Error("cron-skips response was empty");
  }
  return body;
}
