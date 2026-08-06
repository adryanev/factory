/**
 * The display vocabulary for cost (issue 12, spec: "Cost"). The two rules
 * are rendered as words, not symbols: an agent that reported no usage shows
 * "tidak didukung" — never an estimated number — and the Project total is a
 * "batas bawah, bukan total" (lower bound, not a total), stated in full.
 */

/** An agent whose turn reported no token usage — the UI shows this, never a guessed figure. */
export const COST_UNSUPPORTED_LABEL = "tidak didukung";

/** The Project total's nature, stated in words (spec: "total Project adalah batas bawah, bukan total"). */
export const COST_LOWER_BOUND_NOTE = "Batas bawah, bukan total";

/** The running-cost label on the run-detail screen while the Run is in flight (AC8). */
export const COST_RUNNING_LABEL = "Biaya berjalan";

/**
 * Formats a stored `cost_usd` numeric string for display. A null (no usage
 * reported) stays null — the caller renders {@link COST_UNSUPPORTED_LABEL}.
 * Sub-cent amounts keep the stored 6-decimal precision so a real-but-tiny
 * priced cost never reads as a rounded zero: the number is priced, not
 * estimated, and rounding it away would be the same lie this issue forbids.
 */
export function formatUsd(value: string | null): string | null {
  if (value === null) return null;
  const amount = Number(value);
  if (amount > 0 && amount < 0.01) {
    return `$${amount.toFixed(6)}`;
  }
  return `$${amount.toFixed(2)}`;
}
