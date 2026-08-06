import "./StepRunCost.css";
import type { StepRunCostData } from "../cost/types";
import { CostValue } from "./CostValue";

/**
 * One StepRun's cost with the per-attempt breakdown (issue 12, AC6 — "biaya
 * per attempt terlihat, yang berguna persis saat menyelidiki StepRun yang
 * gagal berulang"). A retried StepRun has one row per attempt; the total is
 * the plain sum of the stored figures (AC5), never a recomputation.
 */
export interface StepRunCostProps {
  data: StepRunCostData;
}

export function StepRunCost({ data }: StepRunCostProps): JSX.Element {
  return (
    <div className="step-run-cost">
      <div className="step-run-cost__total">
        <span className="step-run-cost__total-label">total</span>
        <CostValue
          supported={data.totalCostUsd !== null}
          costUsd={data.totalCostUsd}
        />
      </div>
      <ul className="step-run-cost__attempts">
        {data.attempts.map((attempt) => (
          <li key={attempt.attempt} className="step-run-cost__attempt">
            <span className="step-run-cost__attempt-label">attempt {attempt.attempt}</span>
            <CostValue supported={attempt.supported} costUsd={attempt.costUsd} tokens={attempt.tokens} />
          </li>
        ))}
      </ul>
    </div>
  );
}
