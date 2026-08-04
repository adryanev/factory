import "./RunCost.css";
import type { RunCostData } from "../cost/types";
import { COST_RUNNING_LABEL, formatUsd } from "../cost/format";

/**
 * One Run's cost — the figure on the run-detail screen, the same screen
 * that carries the cancel button (issue 12, AC8: "biaya berjalan tampil
 * selagi Run berjalan, di layar yang sudah memuat tombol cancel"). While
 * the Run is in flight (`runEnded: false`) the total is the running cost —
 * the sum of completed attempts so far — and is labelled as such; once the
 * Run ends it is simply the total.
 */
export interface RunCostProps {
  data: RunCostData;
}

export function RunCost({ data }: RunCostProps): JSX.Element {
  const running = !data.runEnded;
  return (
    <div className="run-cost">
      <span className="run-cost__label">{running ? COST_RUNNING_LABEL : "total"}</span>
      <span className="run-cost__usd">{formatUsd(data.totalCostUsd) ?? "—"}</span>
      {!running && data.unsupportedAttempts > 0 ? (
        <span className="run-cost__note">
          {data.unsupportedAttempts} attempt tanpa laporan pemakaian
        </span>
      ) : null}
    </div>
  );
}
