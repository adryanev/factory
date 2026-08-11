import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "../questions/api";

export interface RunnerPoolRecord {
  id: string;
  desiredState: "active" | "draining" | "revoked";
  tags: string[];
  slots: number;
  protocolVersion: number | null;
  releaseVersion: string | null;
  lastHeartbeatAt: string | null;
  activeLeases: number;
}

export interface RunnerPoolPage {
  runners: RunnerPoolRecord[];
}

export async function fetchRunners(): Promise<RunnerPoolRecord[]> {
  const response = await fetch("/runners");
  if (!response.ok) {
    throw new Error(`request failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  const body = text ? (JSON.parse(text) as RunnerPoolPage) : undefined;
  if (body?.runners === undefined) {
    throw new Error("runners response was empty");
  }
  return body.runners;
}

export async function drainRunner(runnerId: string): Promise<void> {
  await runnerAction(runnerId, "drain");
}

export async function revokeRunner(runnerId: string): Promise<void> {
  await runnerAction(runnerId, "revoke");
}

async function runnerAction(runnerId: string, action: "drain" | "revoke"): Promise<void> {
  const response = await fetch(`/runners/${encodeURIComponent(runnerId)}/${action}`, {
    method: "POST",
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  if (!response.ok) {
    throw new Error(`request failed: HTTP ${response.status}`);
  }
}
