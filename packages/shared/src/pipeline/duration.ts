import { z } from "zod";

/**
 * Durations in the Pipeline definition are constants, never expressions:
 * "30m", "45m", "2h", "7d", "60s". No unit conversion happens here — the
 * string is the wire form and the only form.
 */
export const DURATION_PATTERN = /^[1-9][0-9]*(ms|s|m|h|d)$/;

export const durationSchema = z
  .string()
  .regex(DURATION_PATTERN, "must be a duration like '30m', '2h', or '7d'");

/** `humanTimeout:` additionally accepts the literal "none" (the default). */
export const humanTimeoutSchema = z.union([z.literal("none"), durationSchema]);

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses a validated duration string into milliseconds — the arithmetic half of `unschedulableAfter`/`humanTimeout` enforcement (issue #25). Throws on a malformed string, matching the schema's own pattern. */
export function parseDuration(value: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m|h|d)$/.exec(value);
  if (match === null) {
    throw new Error(`invalid duration: '${value}' — must match ${DURATION_PATTERN}`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!;
  return amount * UNIT_MS[unit]!;
}
