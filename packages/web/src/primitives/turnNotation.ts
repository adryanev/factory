/**
 * Rule this exists for (spec.md "Bahasa visual"; issue 13 §7 "Notasi
 * giliran"; CONTEXT.md "StepRun" — turn and attempt are two separate
 * numberings with different reset rules):
 *
 *   "notasi giliran ditulis panjang (`giliran 4 · attempt 1`) di mana-mana
 *   kecuali di nama branch, di mana ia literal dan disalin ke
 *   `git checkout`."
 *
 * Two facts, two renderings, kept as two named functions on purpose so a
 * future edit can't quietly collapse them back into one "short form" and
 * reintroduce the confusion issue 13 spent its one reversed recommendation
 * undoing: `t4-a1` reads as one token even though attempt is a retry
 * counter that resets per StepRun and turn is not.
 */
export interface TurnAttempt {
  turn: number;
  attempt: number;
}

/** Long form — every display surface except a Branch name. */
export function formatTurnLong({ turn, attempt }: TurnAttempt): string {
  return `giliran ${turn} · attempt ${attempt}`;
}

/**
 * Literal form used inside a Branch name only
 * (`run/<run-id>/<key>/t<turn>-a<attempt>`) — this is what a person copies
 * into `git checkout`. Never use this for prose or a label.
 */
export function formatTurnForBranchName({ turn, attempt }: TurnAttempt): string {
  return `t${turn}-a${attempt}`;
}
