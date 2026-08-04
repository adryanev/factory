import { useEffect, useRef, useState } from "react";
import { validatePipelineDefinition, type Pipeline } from "@factory/shared";
import {
  FanOutSummary,
  formatTurnForBranchName,
  formatTurnLong,
  StatusMark,
  type FanOutBranch,
} from "../primitives";
import { RunCost } from "../primitives/RunCost";
import type { RunCostData } from "../cost/types";
import "../tokens";
import type { StepRunStatus } from "../tokens/status";
import {
  cancelRun,
  fetchLogChunk,
  fetchLogTail,
  fetchRun,
  fetchRunCost,
  fetchStepRunArtifacts,
  type ArtifactRecord,
  type RunDetail,
  type RunPollResult,
  type StepRunRecord,
} from "./api";
import "./RunScreen.css";

const UNSCHEDULED_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

const STATUS_LABEL: Record<StepRunStatus, string> = {
  ready: "Ready",
  running: "Running",
  "awaiting-human": "Awaiting human",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

type InspectorTab = "log" | "output" | "artifact" | "info";

interface RunScreenProps {
  projectId: string;
  runId: string;
  /** A useful seam for a server-rendered shell and deterministic RTL fixtures. */
  initialData?: RunDetail;
  /** Defaults to Date.now. The screen reads it on every graph poll. */
  now?: () => number;
  pollIntervalMs?: number;
}

interface GraphNodeModel {
  key: string;
  label: string;
  stage: number;
  pipelineStep: Pipeline["steps"][string] | undefined;
  stepRun: StepRunRecord | undefined;
  branchRuns: StepRunRecord[];
  fanOut: boolean;
}

interface BlockingReason {
  kind: "awaiting-human" | "unscheduled" | "failed";
  stepRun: StepRunRecord;
  ageMs?: number;
}

interface LogState {
  text: string;
  offset: number;
  ended: boolean;
  loading: boolean;
  error: string | null;
}

function statusLabel(status: StepRunStatus): string {
  return STATUS_LABEL[status];
}

function parsePipeline(definition: string | undefined): Pipeline | null {
  if (definition === undefined) return null;
  try {
    const result = validatePipelineDefinition(definition);
    return result.valid ? result.pipeline : null;
  } catch {
    return null;
  }
}

function isUnscheduledOverThreshold(stepRun: StepRunRecord, nowMs: number): boolean {
  return (
    stepRun.outcome === "ready" &&
    nowMs - new Date(stepRun.readyAt).getTime() > UNSCHEDULED_AFTER_MS
  );
}

function formatAge(ageMs: number): string {
  const totalMinutes = Math.max(1, Math.floor(ageMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function branchName(runId: string, stepRun: StepRunRecord): string {
  const branch = stepRun.branchKey === null ? "" : `/${stepRun.branchKey}`;
  return `run/${runId}/${stepRun.stepKey}${branch}/${formatTurnForBranchName(stepRun)}`;
}

function stepLabel(stepRun: StepRunRecord): string {
  return stepRun.branchKey === null
    ? stepRun.stepKey
    : `${stepRun.stepKey} · ${stepRun.branchKey}`;
}

function dependentSteps(pipeline: Pipeline | null, stepKey: string): Pipeline["steps"][string][] {
  if (pipeline === null) return [];
  return Object.values(pipeline.steps).filter((step) => step.after.includes(stepKey));
}

/** A failed branch under Join any is not a Run blocker. */
function participatesInBlockingJoin(
  pipeline: Pipeline | null,
  stepRun: StepRunRecord,
): boolean {
  const dependants = dependentSteps(pipeline, stepRun.stepKey);
  if (dependants.length === 0) return true;
  return !dependants.some((step) => step.join === "any");
}

function blockingReasons(detail: RunDetail, pipeline: Pipeline | null, nowMs: number): BlockingReason[] {
  if (detail.run.outcome !== null) return [];
  return detail.stepRuns
    .filter((stepRun) => {
      if (stepRun.outcome === "awaiting-human" || stepRun.outcome === "failed") {
        return participatesInBlockingJoin(pipeline, stepRun);
      }
      return isUnscheduledOverThreshold(stepRun, nowMs);
    })
    .map((stepRun) => {
      if (stepRun.outcome === "awaiting-human") {
        return { kind: "awaiting-human" as const, stepRun };
      }
      if (stepRun.outcome === "failed") {
        return { kind: "failed" as const, stepRun };
      }
      return {
        kind: "unscheduled" as const,
        stepRun,
        ageMs: nowMs - new Date(stepRun.readyAt).getTime(),
      };
    })
    .sort((a, b) => {
      const order = { "awaiting-human": 0, unscheduled: 1, failed: 2 } as const;
      return order[a.kind] - order[b.kind];
    });
}

function stageFor(
  key: string,
  pipeline: Pipeline,
  memo: Map<string, number>,
  visiting: Set<string>,
): number {
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  if (visiting.has(key)) return 0;
  visiting.add(key);
  const step = pipeline.steps[key];
  const stage = step === undefined || step.after.length === 0
    ? 0
    : Math.max(...step.after.map((dependency) => stageFor(dependency, pipeline, memo, visiting) + 1));
  visiting.delete(key);
  memo.set(key, stage);
  return stage;
}

function graphNodes(detail: RunDetail, pipeline: Pipeline | null): GraphNodeModel[] {
  const keys = new Set<string>(pipeline ? Object.keys(pipeline.steps) : []);
  detail.stepRuns.forEach((stepRun) => keys.add(stepRun.stepKey));
  const memo = new Map<string, number>();
  return [...keys].map((key) => {
    const pipelineStep = pipeline?.steps[key];
    const runs = detail.stepRuns.filter((stepRun) => stepRun.stepKey === key);
    const branchRuns = runs.filter((stepRun) => stepRun.branchKey !== null);
    const fanOut = pipelineStep?.branches !== undefined || pipelineStep?.branchesFrom !== undefined;
    return {
      key,
      label: key,
      stage: pipeline ? stageFor(key, pipeline, memo, new Set()) : 0,
      pipelineStep,
      stepRun: runs.find((stepRun) => stepRun.branchKey === null),
      branchRuns,
      fanOut,
    };
  }).sort((a, b) => a.stage - b.stage || a.key.localeCompare(b.key));
}

function declaredBranchKeys(node: GraphNodeModel): string[] {
  return node.pipelineStep?.branches?.map((branch) => branch.key) ?? [];
}

function fanOutBranches(node: GraphNodeModel, nowMs: number): FanOutBranch[] {
  const known = new Map(node.branchRuns.map((stepRun) => [stepRun.branchKey!, stepRun]));
  const keys = new Set([...declaredBranchKeys(node), ...known.keys()]);
  if (keys.size === 0 && node.pipelineStep?.branchesFrom !== undefined) {
    return [{ key: "waiting for fan-out", status: "ready" }];
  }
  return [...keys].map((key) => {
    const stepRun = known.get(key);
    return {
      key,
      status: stepRun?.outcome ?? "ready",
      unscheduledOverThreshold: stepRun === undefined
        ? false
        : isUnscheduledOverThreshold(stepRun, nowMs),
    };
  });
}

function focusStepRun(detail: RunDetail, pipeline: Pipeline | null, nowMs: number): string | null {
  const blockers = blockingReasons(detail, pipeline, nowMs);
  return blockers[0]?.stepRun.id ?? detail.stepRuns[0]?.id ?? null;
}

function runStatus(detail: RunDetail): string {
  if (detail.run.outcome !== null) return detail.run.outcome;
  if (detail.run.cancelRequestedAt !== null) return "Cancellation requested";
  return "Running";
}

function displayDuration(stepRun: StepRunRecord, nowMs: number): string | null {
  if (stepRun.startedAt === null) return null;
  const duration = Math.max(0, nowMs - new Date(stepRun.startedAt).getTime());
  return formatAge(duration);
}

function GraphNode({
  node,
  detail,
  nowMs,
  selectedId,
  onSelect,
}: {
  node: GraphNodeModel;
  detail: RunDetail;
  nowMs: number;
  selectedId: string | null;
  onSelect: (stepRunId: string) => void;
}): React.JSX.Element {
  const selected = node.stepRun?.id === selectedId;
  const status = node.stepRun?.outcome ?? "ready";
  const stale = node.stepRun !== undefined && isUnscheduledOverThreshold(node.stepRun, nowMs);
  const visibleStatus = stale ? "Unscheduled (stale)" : statusLabel(status);
  return (
    <article
      className={`run-graph__node${selected ? " run-graph__node--selected" : ""}${stale ? " run-graph__node--stale" : ""}`}
      data-testid={`graph-node-${node.key}`}
      data-fan-out={node.fanOut}
    >
      <button
        type="button"
        className="run-graph__node-button"
        aria-pressed={selected}
        aria-label={`${node.label}, ${visibleStatus}`}
        onClick={() => {
          if (node.stepRun) onSelect(node.stepRun.id);
        }}
      >
        <span className="run-graph__node-title">{node.label}</span>
        <span className="run-graph__node-status">
          <StatusMark status={status} label={visibleStatus} />
          <span>{visibleStatus}</span>
        </span>
      </button>
      {node.stepRun ? (
        <div className="run-graph__node-meta">
          <span>{formatTurnLong(node.stepRun)}</span>
          {displayDuration(node.stepRun, nowMs) ? <span>{displayDuration(node.stepRun, nowMs)}</span> : null}
        </div>
      ) : (
        <p className="run-graph__placeholder">Not materialized yet</p>
      )}
      {stale ? (
        <p className="run-graph__stale">Unscheduled for {formatAge(nowMs - new Date(node.stepRun!.readyAt).getTime())}</p>
      ) : null}
      {node.fanOut ? (
        <FanOutSummary
          stepLabel={node.label}
          branches={fanOutBranches(node, nowMs)}
          onSelectBranch={(branchKey) => {
            const branch = node.branchRuns.find((stepRun) => stepRun.branchKey === branchKey);
            if (branch) onSelect(branch.id);
          }}
        />
      ) : null}
      {node.pipelineStep?.join !== undefined ? (
        <span className="run-graph__join">Join: {formatJoin(node.pipelineStep.join)}</span>
      ) : null}
      {node.pipelineStep?.branchesFrom !== undefined && node.branchRuns.length === 0 ? (
        <span className="run-graph__waiting">Waiting for fan-out</span>
      ) : null}
      <span className="sr-only">Run {detail.run.id}</span>
    </article>
  );
}

function formatJoin(join: NonNullable<Pipeline["steps"][string]["join"]>): string {
  if (typeof join === "string") return join;
  return `at least ${join.min}`;
}

function RunGraph({
  detail,
  pipeline,
  nowMs,
  selectedId,
  onSelect,
}: {
  detail: RunDetail;
  pipeline: Pipeline | null;
  nowMs: number;
  selectedId: string | null;
  onSelect: (stepRunId: string) => void;
}): React.JSX.Element {
  const nodes = graphNodes(detail, pipeline);
  const maxStage = Math.max(0, ...nodes.map((node) => node.stage));
  const columns = Array.from({ length: maxStage + 1 }, (_, stage) => nodes.filter((node) => node.stage === stage));
  return (
    <section className="run-graph" aria-label="Run graph" data-testid="run-graph">
      <div className="run-graph__columns" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(14rem, 1fr))` }}>
        {columns.map((column, index) => (
          <div className="run-graph__column" key={index}>
            <h3>Stage {index + 1}</h3>
            {column.map((node) => (
              <GraphNode
                key={node.key}
                node={node}
                detail={detail}
                nowMs={nowMs}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function BlockingBanner({ reason }: { reason: BlockingReason | undefined }): React.JSX.Element | null {
  if (reason === undefined) return null;
  const label = stepLabel(reason.stepRun);
  if (reason.kind === "awaiting-human") {
    return (
      <div className="run-banner run-banner--awaiting" role="alert" data-testid="blocking-banner" data-blocker-kind="awaiting-human">
        <StatusMark status="awaiting-human" label="Awaiting human" size={18} />
        <div>
          <strong>Run is waiting for a human at {label}.</strong>
          <p>The downstream steps will not be scheduled until this question is answered.</p>
        </div>
      </div>
    );
  }
  if (reason.kind === "unscheduled") {
    return (
      <div className="run-banner run-banner--unscheduled" role="alert" data-testid="blocking-banner" data-blocker-kind="unscheduled">
        <StatusMark status="ready" label="Ready but unscheduled" size={18} />
        <div>
          <strong>{label} has no matching Runner.</strong>
          <p>Unscheduled for {formatAge(reason.ageMs ?? 0)}. The StepRun is stale, not failed.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="run-banner run-banner--failed" role="alert" data-testid="blocking-banner" data-blocker-kind="failed">
      <StatusMark status="failed" label="Failed" size={18} />
      <div>
        <strong>{label} failed and is holding the Run.</strong>
        <p>{reason.stepRun.reason ?? "The StepRun ended without a successful output."}</p>
      </div>
    </div>
  );
}

function RunHeader({
  detail,
  pipeline,
  cost,
  onCancel,
}: {
  detail: RunDetail;
  pipeline: Pipeline | null;
  cost: RunCostData | null;
  onCancel: () => void;
}): React.JSX.Element {
  const canCancel = detail.run.outcome === null && detail.run.cancelRequestedAt === null;
  const runMark: StepRunStatus = detail.run.outcome === "succeeded"
    ? "succeeded"
    : detail.run.outcome === "failed"
      ? "failed"
      : detail.run.outcome === "cancelled"
        ? "cancelled"
        : "running";
  const counts = detail.stepRuns.reduce<Record<string, number>>((result, stepRun) => {
    result[stepRun.outcome] = (result[stepRun.outcome] ?? 0) + 1;
    return result;
  }, {});
  return (
    <>
      <header className="run-header">
        <div>
          <p className="run-header__eyebrow">Run {detail.run.id}</p>
          <h1>{pipeline?.name ?? detail.run.pipelinePath}</h1>
          <p className="run-header__meta">
            <span className="run-header__status"><StatusMark status={runMark} label={runStatus(detail)} /> {runStatus(detail)}</span>
            <span>{detail.run.triggerKind === "manual" ? "Triggered manually" : "Triggered by automation"}</span>
            <code>{detail.run.refBranch} @ {detail.run.refSha}</code>
          </p>
        </div>
        <div className="run-header__actions">
          {cost ? <RunCost data={cost} /> : null}
          {canCancel ? (
            <button type="button" className="button button--danger" onClick={onCancel}>
              Cancel Run
            </button>
          ) : null}
        </div>
      </header>
      <div className="run-counts" aria-label="StepRun counts">
        <span><StatusMark status="succeeded" label="Succeeded" /> {counts.succeeded ?? 0} succeeded</span>
        <span><StatusMark status="running" label="Running" /> {counts.running ?? 0} running</span>
        <span><StatusMark status="failed" label="Failed" /> {counts.failed ?? 0} failed</span>
        <span><StatusMark status="skipped" label="Skipped" /> {counts.skipped ?? 0} skipped</span>
      </div>
    </>
  );
}

function LogPanel({
  detail,
  selectedStepRun,
  logStepRunId,
  logStates,
  onSelectLog,
}: {
  detail: RunDetail;
  selectedStepRun: StepRunRecord | undefined;
  logStepRunId: string | null;
  logStates: Record<string, LogState>;
  onSelectLog: (stepRunId: string) => void;
}): React.JSX.Element {
  const logRuns = selectedStepRun?.branchKey !== null && selectedStepRun !== undefined
    ? detail.stepRuns.filter((stepRun) => stepRun.stepKey === selectedStepRun.stepKey && stepRun.branchKey !== null)
    : selectedStepRun ? [selectedStepRun] : [];
  const active = logRuns.find((stepRun) => stepRun.id === logStepRunId) ?? logRuns[0];
  const state = active ? logStates[active.id] : undefined;
  return (
    <section className="inspector-log" aria-label="Branch logs">
      {logRuns.length > 0 ? (
        <div className="log-tabs" role="tablist" aria-label="Logs by branch">
          {logRuns.map((stepRun) => (
            <button
              type="button"
              role="tab"
              key={stepRun.id}
              data-testid={`log-branch-tab-${stepRun.branchKey ?? stepRun.stepKey}`}
              aria-selected={active?.id === stepRun.id}
              onClick={() => onSelectLog(stepRun.id)}
            >
              {stepRun.branchKey ?? stepRun.stepKey}
            </button>
          ))}
        </div>
      ) : null}
      {active === undefined ? (
        <div className="empty-state">Select a StepRun to inspect its log.</div>
      ) : active.kind === "pull-request" ? (
        <div className="empty-state"><strong>No Runner log.</strong><br />This StepRun runs in the control plane.</div>
      ) : state?.error ? (
        <p role="alert" className="inline-error">Could not load this branch log: {state.error}</p>
      ) : (
        <>
          <p className="log-turn">{formatTurnLong(active)}</p>
          <pre className="log-view" aria-label={`${active.branchKey ?? active.stepKey} log`} aria-busy={state?.loading ?? true}>
            {state?.text || (state?.loading ? "Loading branch log…" : "No log chunks yet.")}
          </pre>
        </>
      )}
      <p className="inspector-note">Logs stay separate by branch and attempt. There is no cross-branch stream.</p>
    </section>
  );
}

function OutputPanel({ stepRun }: { stepRun: StepRunRecord | undefined }): React.JSX.Element {
  if (stepRun === undefined || stepRun.outputData === null) {
    return <div className="empty-state"><strong>Output not available.</strong><br />This StepRun has not emitted a structured output.</div>;
  }
  return <pre className="data-view">{JSON.stringify(stepRun.outputData, null, 2)}</pre>;
}

function ArtifactPanel({
  stepRun,
  artifacts,
  onLoad,
}: {
  stepRun: StepRunRecord | undefined;
  artifacts: Record<string, ArtifactRecord[] | "loading" | "error">;
  onLoad: (stepRunId: string) => void;
}): React.JSX.Element {
  useEffect(() => {
    if (stepRun !== undefined && artifacts[stepRun.id] === undefined) {
      onLoad(stepRun.id);
    }
  }, [artifacts, onLoad, stepRun]);
  if (stepRun === undefined) return <div className="empty-state">Select a StepRun first.</div>;
  const state = artifacts[stepRun.id];
  if (state === undefined) {
    return <div className="empty-state" aria-busy="true">Loading artifacts…</div>;
  }
  if (state === "loading") return <div className="empty-state" aria-busy="true">Loading artifacts…</div>;
  if (state === "error") return <p role="alert" className="inline-error">Could not load artifacts.</p>;
  if (state.length === 0) return <div className="empty-state">No artifacts for this StepRun.</div>;
  return (
    <ul className="artifact-list">
      {state.map((artifact) => (
        <li key={artifact.id}>
          <span><strong>{artifact.key}</strong><small>{artifact.kind} · {artifact.sizeBytes} bytes</small></span>
          <span className="artifact-list__date">{new Date(artifact.createdAt).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

function InfoPanel({ runId, stepRun }: { runId: string; stepRun: StepRunRecord | undefined }): React.JSX.Element {
  if (stepRun === undefined) return <div className="empty-state">Select a StepRun first.</div>;
  const status = statusLabel(stepRun.outcome);
  return (
    <dl className="run-info">
      <dt>Status</dt>
      <dd><StatusMark status={stepRun.outcome} label={status} /> {status}</dd>
      <dt>Turn</dt>
      <dd>{formatTurnLong(stepRun)}</dd>
      <dt>Branch</dt>
      <dd><code className="branch-name">{branchName(runId, stepRun)}</code><small>Copy this literal into git checkout.</small></dd>
      <dt>Runner requirements</dt>
      <dd>{stepRun.requiredTags.length > 0 ? stepRun.requiredTags.join(", ") : "No special tags"}</dd>
      <dt>Reason</dt>
      <dd>{stepRun.reason ?? "No reason recorded."}</dd>
      {stepRun.prUrl ? <><dt>Pull request</dt><dd><a href={stepRun.prUrl}>{stepRun.prNumber ? `#${stepRun.prNumber}` : stepRun.prUrl}</a></dd></> : null}
    </dl>
  );
}

function Inspector({
  detail,
  runId,
  selectedStepRun,
  tab,
  setTab,
  logStepRunId,
  logStates,
  onSelectLog,
  artifacts,
  onLoadArtifacts,
}: {
  detail: RunDetail;
  runId: string;
  selectedStepRun: StepRunRecord | undefined;
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
  logStepRunId: string | null;
  logStates: Record<string, LogState>;
  onSelectLog: (stepRunId: string) => void;
  artifacts: Record<string, ArtifactRecord[] | "loading" | "error">;
  onLoadArtifacts: (stepRunId: string) => void;
}): React.JSX.Element {
  const tabs: [InspectorTab, string][] = [["log", "Log"], ["output", "Output"], ["artifact", "Artifacts"], ["info", "Info"]];
  return (
    <aside className="run-inspector" aria-label="StepRun inspector" data-testid="run-inspector">
      <header className="run-inspector__header">
        <div>
          <p className="run-header__eyebrow">Selected StepRun</p>
          <h2>{selectedStepRun ? stepLabel(selectedStepRun) : "No StepRun selected"}</h2>
        </div>
        {selectedStepRun ? <StatusMark status={selectedStepRun.outcome} label={statusLabel(selectedStepRun.outcome)} size={20} /> : null}
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="StepRun details">
        {tabs.map(([value, label]) => (
          <button type="button" role="tab" key={value} aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>
        ))}
      </div>
      <div className="inspector-panel" role="tabpanel">
        {tab === "log" ? <LogPanel detail={detail} selectedStepRun={selectedStepRun} logStepRunId={logStepRunId} logStates={logStates} onSelectLog={onSelectLog} /> : null}
        {tab === "output" ? <OutputPanel stepRun={selectedStepRun} /> : null}
        {tab === "artifact" ? <ArtifactPanel stepRun={selectedStepRun} artifacts={artifacts} onLoad={onLoadArtifacts} /> : null}
        {tab === "info" ? <InfoPanel runId={runId} stepRun={selectedStepRun} /> : null}
      </div>
    </aside>
  );
}

function CancellationConfirmation({
  onConfirm,
  onDismiss,
}: {
  onConfirm: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="cancel-confirm" role="alertdialog" aria-label="Confirm Run cancellation">
      <h2>Cancel this Run?</h2>
      <p>The control plane records the intent now. Running StepRuns will stop through their existing heartbeat channel; saved logs and artifacts remain available.</p>
      <div className="cancel-confirm__actions">
        <button type="button" className="button button--danger" onClick={onConfirm}>Confirm cancel</button>
        <button type="button" className="button" onClick={onDismiss}>Keep running</button>
      </div>
    </div>
  );
}

export function RunScreen({
  projectId,
  runId,
  initialData,
  now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: RunScreenProps): React.JSX.Element {
  const nowSource = useRef<() => number>(now ?? (() => Date.now()));
  const [detail, setDetail] = useState<RunDetail | null>(initialData ?? null);
  const [cost, setCost] = useState<RunCostData | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const etagRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => nowSource.current());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("log");
  const [logStepRunId, setLogStepRunId] = useState<string | null>(null);
  const [logStates, setLogStates] = useState<Record<string, LogState>>({});
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactRecord[] | "loading" | "error">>({});
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const poll = async (): Promise<void> => {
      try {
        const result: RunPollResult = await fetchRun(projectId, runId, etagRef.current);
        if (disposed) return;
        setNowMs(nowSource.current());
        if (result.status === "ok") {
          setDetail(result.data);
          setEtag(result.etag);
          etagRef.current = result.etag ?? undefined;
          setError(null);
        } else {
          setEtag(result.etag);
          etagRef.current = result.etag ?? undefined;
        }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), pollIntervalMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [projectId, runId, pollIntervalMs]);

  useEffect(() => {
    let disposed = false;
    void fetchRunCost(projectId, runId)
      .then((runCost) => {
        if (!disposed) setCost(runCost);
      })
      .catch(() => {
        // Cost is a separate aggregation endpoint; a missing cost must not hide the Graph.
      });
    return () => {
      disposed = true;
    };
  }, [projectId, runId]);

  const pipeline = parsePipeline(detail?.run.definition);
  const blockers = detail ? blockingReasons(detail, pipeline, nowMs) : [];
  const selectedStepRun = detail?.stepRuns.find((stepRun) => stepRun.id === selectedId);

  useEffect(() => {
    if (detail === null) return;
    const next = selectedId !== null && detail.stepRuns.some((stepRun) => stepRun.id === selectedId)
      ? selectedId
      : focusStepRun(detail, pipeline, nowMs);
    if (next !== selectedId) setSelectedId(next);
    const selected = detail.stepRuns.find((stepRun) => stepRun.id === next);
    if (selected && (logStepRunId === null || !detail.stepRuns.some((stepRun) => stepRun.id === logStepRunId))) {
      setLogStepRunId(selected.id);
    }
  }, [detail, nowMs, pipeline, selectedId, logStepRunId]);

  const activeLogStepRun = detail?.stepRuns.find((stepRun) => stepRun.id === logStepRunId);
  useEffect(() => {
    if (tab !== "log" || activeLogStepRun === undefined) return;
    let disposed = false;
    let offset = logStates[activeLogStepRun.id]?.offset ?? 0;
    const stepRunId = activeLogStepRun.id;
    const attempt = activeLogStepRun.attempt;
    const currentText = logStates[stepRunId]?.text ?? "";
    setLogStates((states) => ({
      ...states,
      [stepRunId]: { text: currentText, offset, ended: false, loading: true, error: null },
    }));

    const tail = async (): Promise<void> => {
      try {
        const result = await fetchLogTail(stepRunId, attempt, offset);
        for (const chunk of result.chunks.sort((a, b) => a.seq - b.seq)) {
          const text = await fetchLogChunk(chunk.getUrl);
          if (disposed) return;
          setLogStates((states) => ({
            ...states,
            [stepRunId]: {
              text: `${states[stepRunId]?.text ?? ""}${text}`,
              offset: result.nextOffset,
              ended: result.ended,
              loading: false,
              error: null,
            },
          }));
        }
        offset = result.nextOffset;
        if (!disposed) {
          setLogStates((states) => ({
            ...states,
            [stepRunId]: {
              text: states[stepRunId]?.text ?? "",
              offset,
              ended: result.ended,
              loading: !result.ended,
              error: null,
            },
          }));
        }
        if (!disposed && !result.ended) await tail();
      } catch (reason) {
        if (!disposed) {
          setLogStates((states) => ({
            ...states,
            [stepRunId]: {
              text: states[stepRunId]?.text ?? "",
              offset,
              ended: false,
              loading: false,
              error: reason instanceof Error ? reason.message : String(reason),
            },
          }));
        }
      }
    };
    void tail();
    return () => {
      disposed = true;
    };
  }, [activeLogStepRun?.attempt, activeLogStepRun?.id, tab]);

  const loadArtifacts = (stepRunId: string): void => {
    if (artifacts[stepRunId] !== undefined) return;
    setArtifacts((current) => ({ ...current, [stepRunId]: "loading" }));
    void fetchStepRunArtifacts(stepRunId)
      .then((items) => setArtifacts((current) => ({ ...current, [stepRunId]: items })))
      .catch(() => setArtifacts((current) => ({ ...current, [stepRunId]: "error" })));
  };

  const requestCancel = (): void => {
    if (detail === null || detail.run.cancelRequestedAt !== null) return;
    const intentAt = new Date(nowSource.current()).toISOString();
    setConfirmCancel(false);
    setCancelError(null);
    // Acknowledge intent before the network round trip. The next poll replaces
    // this optimistic value with the authoritative timestamp.
    setDetail({ ...detail, run: { ...detail.run, cancelRequestedAt: intentAt } });
    void cancelRun(projectId, runId)
      .then((run) => setDetail((current) => current ? { ...current, run } : current))
      .catch((reason) => {
        setCancelError(reason instanceof Error ? reason.message : String(reason));
        setDetail((current) => current ? { ...current, run: { ...current.run, cancelRequestedAt: null } } : current);
      });
  };

  if (detail === null) {
    return <main className="run-page" data-testid="run-screen"><p aria-busy="true">Loading Run…</p></main>;
  }

  const selected = selectedStepRun ?? detail.stepRuns[0];
  return (
    <main className="run-page" data-testid="run-screen">
      <RunHeader detail={detail} pipeline={pipeline} cost={cost} onCancel={() => setConfirmCancel(true)} />
      {detail.run.cancelRequestedAt !== null ? (
        <div className="cancel-intent" role="status" data-testid="cancel-intent">
          <StatusMark status="cancelled" label="Cancellation requested" />
          <span>Cancellation requested at {new Date(detail.run.cancelRequestedAt).toLocaleTimeString()}.</span>
          <small>Workers are stopping in the background; this is intent, not the final outcome.</small>
        </div>
      ) : null}
      {cancelError ? <p role="alert" className="inline-error">Could not cancel the Run: {cancelError}</p> : null}
      <BlockingBanner reason={blockers[0]} />
      {confirmCancel ? <CancellationConfirmation onConfirm={requestCancel} onDismiss={() => setConfirmCancel(false)} /> : null}
      {error ? <p role="alert" className="inline-error">Could not refresh the Run: {error}</p> : null}
      <div className="run-layout" data-testid="run-layout" data-layout="desktop-right-mobile-stack">
        <div className="run-canvas">
          <div className="run-view-heading">
            <div>
              <h2>Graph</h2>
              <p>Graph is the default view. Select a node to keep the Run context while inspecting it.</p>
            </div>
            <span className="poll-note">Refreshes every 3 seconds{etag ? " · conditional" : ""}</span>
          </div>
          <RunGraph
            detail={detail}
            pipeline={pipeline}
            nowMs={nowMs}
            selectedId={selected?.id ?? null}
            onSelect={(stepRunId) => {
              setSelectedId(stepRunId);
              setLogStepRunId(stepRunId);
            }}
          />
        </div>
        <Inspector
          detail={detail}
          runId={runId}
          selectedStepRun={selected}
          tab={tab}
          setTab={setTab}
          logStepRunId={logStepRunId}
          logStates={logStates}
          onSelectLog={(stepRunId) => {
            setSelectedId(stepRunId);
            setLogStepRunId(stepRunId);
          }}
          artifacts={artifacts}
          onLoadArtifacts={loadArtifacts}
        />
      </div>
    </main>
  );
}

export { UNSCHEDULED_AFTER_MS, blockingReasons, isUnscheduledOverThreshold };
export type { RunScreenProps, BlockingReason };
