import "./FanOutSummary.css";
import { StatusMark } from "./StatusMark";
import {
  summarizeFanOut,
  type FanOutBranch,
} from "./fanOut";

export interface FanOutSummaryProps {
  /** The Step name that fanned out (CONTEXT.md "Fan-out"), e.g. "implement". */
  stepLabel: string;
  branches: readonly FanOutBranch[];
  onSelectBranch?: (key: string) => void;
  /** Opens the filtered list view for this fan-out (issue 13 §1). */
  onShowRemainder?: (hiddenCount: number) => void;
}

/**
 * The fan-out summary box (issue 13 §1, CONTEXT.md "Fan-out"/"Key"). See
 * fanOut.ts for the ordering rule this renders. This primitive only lays
 * out the ordered branches plus the remainder row — it does not know how to
 * draw a Run graph or position edges; that belongs to issue #20's Pipeline
 * editor / #14's monitoring canvas, not here.
 */
export function FanOutSummary({
  stepLabel,
  branches,
  onSelectBranch,
  onShowRemainder,
}: FanOutSummaryProps): JSX.Element {
  const { shown, hiddenCount, isSummarized } = summarizeFanOut(branches);
  return (
    <div className="fan-out-summary" data-summarized={isSummarized}>
      <div className="fan-out-summary__label">
        fan-out {stepLabel} · {branches.length} cabang
      </div>
      <ul className="fan-out-summary__list">
        {shown.map((branch) => (
          <li key={branch.key}>
            <button
              type="button"
              className="fan-out-summary__branch"
              onClick={() => onSelectBranch?.(branch.key)}
            >
              {branch.unscheduledOverThreshold ? (
                <StatusMark status={branch.status} label="Unscheduled (stale)" />
              ) : (
                <StatusMark status={branch.status} />
              )}
              <span className="fan-out-summary__key">{branch.key}</span>
            </button>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="fan-out-summary__remainder"
          onClick={() => onShowRemainder?.(hiddenCount)}
        >
          …{hiddenCount} cabang lain
        </button>
      ) : null}
    </div>
  );
}
