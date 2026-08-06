import "./ProjectCost.css";
import type { ProjectCostData } from "../cost/types";
import { COST_LOWER_BOUND_NOTE, formatUsd } from "../cost/format";

/**
 * The Project's total spend (issue 12, AC2/AC9). The nature of the number is
 * stated in full words — "Batas bawah, bukan total" — because it genuinely is
 * a lower bound: agents that reported no usage and Runs still in flight
 * contribute nothing, and the price table is pinned to what was already
 * written. The same attribution the Run rows carry breaks the total down by
 * credential principal, so shared-credential usage is visible.
 */
export interface ProjectCostProps {
  data: ProjectCostData;
}

export function ProjectCost({ data }: ProjectCostProps): JSX.Element {
  return (
    <div className="project-cost">
      <div className="project-cost__head">
        <span className="project-cost__total">{formatUsd(data.totalCostUsd) ?? "—"}</span>
        <span className="project-cost__note">{COST_LOWER_BOUND_NOTE}</span>
      </div>
      <ul className="project-cost__principals">
        {data.byCredentialPrincipal.map((row) => (
          <li key={row.credentialPrincipalId} className="project-cost__principal">
            <span className="project-cost__principal-id">{row.credentialPrincipalId}</span>
            <span className="project-cost__principal-cost">{formatUsd(row.costUsd)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
