/**
 * The Runner pool (issue #33): every registered Runner with its heartbeat
 * status, protocol/lease state, and the drain/revoke buttons that call the
 * admin paths (POST /runners/{id}/drain and /revoke — the same
 * desired_state column the Runner's own CLI writes).
 */
import { useCallback, useEffect, useState } from "react";
import { SUPPORTED_PROTOCOL_RANGE } from "@factory/shared";
import { drainRunner, fetchRunners, revokeRunner, type RunnerPoolRecord } from "./api";

const ONLINE_WINDOW_MS = 30_000;

export interface RunnerPoolScreenProps {
  /** Defaults to Date.now. A seam for deterministic fixtures. */
  now?: () => number;
  pollIntervalMs?: number;
}

function isOnline(runner: RunnerPoolRecord, nowMs: number): boolean {
  return runner.lastHeartbeatAt !== null && nowMs - new Date(runner.lastHeartbeatAt).getTime() <= ONLINE_WINDOW_MS;
}

function isProtocolOutOfRange(runner: RunnerPoolRecord): boolean {
  return (
    runner.protocolVersion !== null &&
    (runner.protocolVersion < SUPPORTED_PROTOCOL_RANGE.min || runner.protocolVersion > SUPPORTED_PROTOCOL_RANGE.max)
  );
}

function formatHeartbeat(runner: RunnerPoolRecord): string {
  if (runner.lastHeartbeatAt === null) return "Never";
  return new Date(runner.lastHeartbeatAt).toLocaleTimeString();
}

export function RunnerPoolScreen({
  now,
  pollIntervalMs = 10_000,
}: RunnerPoolScreenProps = {}): React.JSX.Element {
  const nowSource = now ?? (() => Date.now());
  const [runners, setRunners] = useState<RunnerPoolRecord[] | null>(null);
  const [nowMs, setNowMs] = useState(() => nowSource());
  const [error, setError] = useState<string | null>(null);
  const [busyRunnerId, setBusyRunnerId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRunners(await fetchRunners());
      setNowMs(nowSource());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [nowSource]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, pollIntervalMs]);

  const runAction = useCallback(
    async (runner: RunnerPoolRecord, action: "drain" | "revoke"): Promise<void> => {
      setBusyRunnerId(runner.id);
      setActionError(null);
      try {
        if (action === "drain") {
          await drainRunner(runner.id);
        } else {
          await revokeRunner(runner.id);
        }
        setConfirmRevokeId(null);
        await refresh();
      } catch (reason) {
        setActionError(
          `${action === "drain" ? "Could not drain" : "Could not revoke"} ${runner.id}: ${
            reason instanceof Error ? reason.message : String(reason)
          }`,
        );
      } finally {
        setBusyRunnerId(null);
      }
    },
    [refresh],
  );

  if (error !== null) {
    return <p role="alert">Could not load the Runner pool: {error}</p>;
  }
  if (runners === null) {
    return <p aria-busy="true">Loading the Runner pool…</p>;
  }
  if (runners.length === 0) {
    return (
      <section aria-label="Runner pool">
        <p><strong>The Runner pool is empty.</strong></p>
        <p>Join a machine with a single-use token to add the first Runner.</p>
      </section>
    );
  }
  return (
    <section aria-label="Runner pool" data-testid="runner-pool">
      <h2>Runner pool</h2>
      <p>Online means a heartbeat within the last 30 seconds. Runners outside the supported protocol range are refused work with 426.</p>
      {actionError ? <p role="alert">{actionError}</p> : null}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {runners.map((runner) => {
          const online = isOnline(runner, nowMs);
          const outOfRange = isProtocolOutOfRange(runner);
          return (
            <li key={runner.id}>
              <header>
                <code>{runner.id}</code>
                {" · "}
                <strong>{online ? "Online" : "Offline"}</strong>
                {" · "}
                <strong>{runner.desiredState}</strong>
                {outOfRange ? <span data-testid={`protocol-426-${runner.id}`}> · protocol 426 — out of range</span> : null}
              </header>
              <p>
                {runner.releaseVersion ?? "release unknown"}
                {" · protocol v"}
                {runner.protocolVersion ?? "?"}
                {" · heartbeat "}
                {formatHeartbeat(runner)}
                {" · "}
                {runner.activeLeases} lease{runner.activeLeases === 1 ? "" : "s"}
                {" · "}
                {runner.slots} slot{runner.slots === 1 ? "" : "s"}
                {runner.tags.length > 0 ? ` · tags: ${runner.tags.join(", ")}` : ""}
              </p>
              <p>
                <button
                  type="button"
                  disabled={runner.desiredState !== "active" || busyRunnerId === runner.id}
                  onClick={() => void runAction(runner, "drain")}
                >
                  Drain
                </button>{" "}
                {confirmRevokeId === runner.id ? (
                  <>
                    <button type="button" disabled={busyRunnerId === runner.id} onClick={() => void runAction(runner, "revoke")}>
                      Confirm revoke
                    </button>{" "}
                    <button type="button" disabled={busyRunnerId === runner.id} onClick={() => setConfirmRevokeId(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={runner.desiredState === "revoked" || busyRunnerId === runner.id}
                    onClick={() => setConfirmRevokeId(runner.id)}
                  >
                    Revoke
                  </button>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
