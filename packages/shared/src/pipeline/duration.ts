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
