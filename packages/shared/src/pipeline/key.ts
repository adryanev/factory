/**
 * The Key that distinguishes fan-out siblings (CONTEXT.md: "Key").
 *
 * A Key appears in Branch names, logs, and the UI, so it must be a safe git
 * ref component. Deliberately lowercase-only and un-normalised: the schema
 * rejects "Frontend" outright rather than lower-casing it to "frontend" and
 * comparing. Normalising before the duplicate check would let two keys that
 * only differ by case pass validation and then collide once they both land
 * on the Git Remote as branch names.
 */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const KEY_PATTERN_DESCRIPTION =
  "must match [a-z0-9][a-z0-9._-]{0,63} (lowercase only, no normalisation is applied)";

export function isValidKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}
