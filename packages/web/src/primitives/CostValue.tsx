import "./CostValue.css";
import { COST_UNSUPPORTED_LABEL, formatUsd } from "../cost/format";

/**
 * One cost value — the atomic decision the whole issue exists for: an agent
 * that reported no usage renders {@link COST_UNSUPPORTED_LABEL} ("tidak
 * didukung"), never a number (spec: "Estimasi dilarang"). A priced cost
 * renders its stored `cost_usd` — the number written once at StepRun end,
 * never recomputed — plus the token counts that produced it.
 */
export interface CostValueProps {
  supported: boolean;
  costUsd: string | null;
  tokens?: { inputTokens: number; outputTokens: number } | null;
}

export function CostValue({ supported, costUsd, tokens }: CostValueProps): JSX.Element {
  if (!supported) {
    return (
      <span className="cost-value" data-supported="false">
        {COST_UNSUPPORTED_LABEL}
      </span>
    );
  }
  return (
    <span className="cost-value" data-supported="true">
      <span className="cost-value__usd">{formatUsd(costUsd)}</span>
      {tokens ? (
        <span className="cost-value__tokens">
          {tokens.inputTokens.toLocaleString("en-US")} in · {tokens.outputTokens.toLocaleString("en-US")} out
        </span>
      ) : null}
    </span>
  );
}
