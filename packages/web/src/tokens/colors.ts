import type { StepRunStatus } from "./status";

/**
 * Typed accessors over tokens.css custom properties. Each value is a CSS
 * `var(--...)` reference, not a resolved colour — the actual value still
 * comes from whichever theme block (`:root[data-theme="light"]` /
 * `[data-theme="dark"]`) is active, so components built against this module
 * are theme-agnostic by construction.
 */
export const color = {
  bg: "var(--bg)",
  paper: "var(--paper)",
  panel: "var(--panel)",
  sunk: "var(--sunk)",
  fg: "var(--fg)",
  fg2: "var(--fg-2)",
  fg3: "var(--fg-3)",
  border: "var(--border)",
  border2: "var(--border-2)",
  primary: "var(--primary)",
  primaryFg: "var(--primary-fg)",
  ring: "var(--ring)",
  info: "var(--info)",
  infoWash: "var(--info-wash)",
  infoLine: "var(--info-line)",
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
  destructiveWash: "var(--destructive-wash)",
  destructiveLine: "var(--destructive-line)",
} as const;

/**
 * The --attention token, deliberately narrowed (spec.md "Bahasa visual"):
 * it marks *only* content a human wrote directly into an Artifact. It must
 * never stand in for a warning, a pending state, "this is the current row",
 * or any other kind of emphasis — reuses like that appear in grilling-ui's
 * own CSS (the `.marker` return banner, `.inboxrow.here`, and the human
 * speaker-name colour in `.thd .who.human`) and are exactly the misuse this
 * rule forbids; they were not carried into this token layer or into
 * StatusMark's colour map.
 *
 * This is exported under its own narrow name, deliberately separate from
 * `color` above, and consumed by exactly one primitive:
 * primitives/HumanAuthoredMark.tsx. Reach for `color.warning` or
 * `color.info` for anything else — never this.
 */
export const humanWrittenInArtifactColor = {
  fg: "var(--attention)",
  wash: "var(--attention-wash)",
  line: "var(--attention-line)",
} as const;

/**
 * One colour role per StepRun status (tokens/tokens.css's --status-* block).
 * Colour is a secondary signal here, never the only one — see
 * primitives/StatusMark.tsx for the shape that carries the primary signal.
 */
export const statusColor: Record<StepRunStatus, string> = {
  ready: "var(--status-ready)",
  running: "var(--status-running)",
  "awaiting-human": "var(--status-awaiting-human)",
  succeeded: "var(--status-succeeded)",
  failed: "var(--status-failed)",
  skipped: "var(--status-skipped)",
  cancelled: "var(--status-cancelled)",
  unschedulable: "var(--status-unschedulable)",
};
