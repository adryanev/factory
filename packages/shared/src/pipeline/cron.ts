/**
 * The 5-field cron language `on: { schedule: [...] }` speaks (spec:
 * "Automation"). Pure: `cronMatches(expression, date)` is a function of two
 * values, so the schedule sweep is idempotent and the overlap rule ("skip
 * when a Run is already active, and record the skip") stays a sweep concern
 * on top of this.
 *
 * Field order and ranges follow the classic vixie-cron shape:
 *   minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6,
 *   0 = Sunday). Seconds are deliberately not supported — the sweep has
 * minute resolution.
 *
 * Each field accepts `*`, a step (`*`/n), a literal, a range `a-b`, a range
 * with a step `a-b`/n, or a comma list of those. `day-of-month` and
 * `day-of-week` are OR'd when both are concrete (cron's classic quirk),
 * `*`-in-one means "any" in the other.
 */

export type CronField = { kind: "any" } | { kind: "set"; values: Set<number> };

const FIELD_COUNT = 5;
const FIELD_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseField(text: string, [min, max]: [number, number]): CronField | null {
  const parts = text.split(",");
  const values = new Set<number>();
  let any = false;

  for (const part of parts) {
    if (part === "*") {
      any = true;
      continue;
    }
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[1]!);
      if (step < 1) return null;
      for (let v = min; v <= max; v += step) values.add(v);
      continue;
    }
    const rangeMatch = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!rangeMatch) return null;
    const from = Number(rangeMatch[1]!);
    const to = Number(rangeMatch[2] ?? rangeMatch[1]!);
    const step = Number(rangeMatch[3] ?? 1);
    if (from < min || to > max || from > to || step < 1) return null;
    for (let v = from; v <= max && v <= to; v += step) values.add(v);
  }

  if (any) return { kind: "any" };
  return { kind: "set", values };
}

/** Structural check for the pipeline schema's `on.schedule` entries. */
export function isValidCronExpression(expression: string): boolean {
  if (expression.trim() !== expression || expression.split(/\s+/).length !== FIELD_COUNT) {
    return false;
  }
  const fields = expression.split(/\s+/);
  return fields.every((field, index) => parseField(field, FIELD_RANGES[index]!) !== null);
}

function fieldMatches(field: CronField, value: number): boolean {
  switch (field.kind) {
    case "any":
      return true;
    case "set":
      return field.values.has(value);
  }
}

/** True when a 5-field cron expression fires at `date` (UTC). */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.split(/\s+/);
  if (fields.length !== FIELD_COUNT) return false;

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();

  if (!fieldMatches(parseField(fields[0]!, FIELD_RANGES[0]!)!, minute)) return false;
  if (!fieldMatches(parseField(fields[1]!, FIELD_RANGES[1]!)!, hour)) return false;
  if (!fieldMatches(parseField(fields[3]!, FIELD_RANGES[3]!)!, month)) return false;

  const domField = parseField(fields[2]!, FIELD_RANGES[2]!)!;
  const dowField = parseField(fields[4]!, FIELD_RANGES[4]!)!;
  const domAny = domField.kind === "any";
  const dowAny = dowField.kind === "any";
  const domMatch = fieldMatches(domField, day);
  const dowMatch = fieldMatches(dowField, dow);
  if (domAny && dowAny) return true;
  if (domAny) return dowMatch;
  if (dowAny) return domMatch;
  return domMatch || dowMatch; // classic cron: concrete dom OR concrete dow.
}
