import "./StatusMark.css";
import { statusColor } from "../tokens/colors";
import type { StepRunStatus } from "../tokens/status";

/**
 * Rule this exists for (spec.md "Bahasa visual" + issue 13 §5):
 * "Status berbentuk, bukan sekadar titik berwarna" — status is a shape, not
 * merely a coloured dot. A user must be able to tell `failed` from
 * `skipped` without comparing hues, and every one of the seven StepRun
 * statuses needs a treatment that survives greyscale.
 *
 * Each status below maps to a distinct SVG glyph (see SHAPE), independent
 * of colour — verified in __tests__/StatusMark.test.tsx, which asserts no
 * two statuses share a glyph. Colour (statusColor, tokens/colors.ts) is a
 * secondary reinforcement layered on top, never the only signal.
 *
 * `cancelled` has no equivalent in prototype 13's MARK set (it never draws
 * that state) — its glyph (an outlined square, stroked like every other
 * glyph here rather than filled, so it doesn't read as heavier or more
 * severe than `failed`) is this extraction's own addition, not lifted from
 * either prototype. Flagged in the handoff.
 */

const DEFAULT_LABEL: Record<StepRunStatus, string> = {
  ready: "Ready",
  running: "Running",
  "awaiting-human": "Awaiting human",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/** Ring style carries no meaning on its own — glyph is what must be unique. */
const DASHED_RING: ReadonlySet<StepRunStatus> = new Set([
  "ready",
  "skipped",
  "cancelled",
]);

type Shape = "none" | "arc" | "bars" | "check" | "cross" | "slash" | "square";

const SHAPE_BY_STATUS: Record<StepRunStatus, Shape> = {
  ready: "none",
  running: "arc",
  "awaiting-human": "bars",
  succeeded: "check",
  failed: "cross",
  skipped: "slash",
  cancelled: "square",
};

function Glyph({ shape }: { shape: Shape }): JSX.Element | null {
  switch (shape) {
    case "none":
      return null;
    case "arc":
      return (
        <path
          className="status-mark__spin"
          d="M8 1.6a6.4 6.4 0 0 1 6.4 6.4"
        />
      );
    case "bars":
      return <path d="M6.6 5.8v4.4M9.4 5.8v4.4" />;
    case "check":
      return <path d="M5.2 8.2l2 2 3.6-3.9" />;
    case "cross":
      return <path d="M6 6l4 4M10 6l-4 4" />;
    case "slash":
      return <path d="M4.8 11.2l6.4-6.4" />;
    case "square":
      return <rect x="5.6" y="5.6" width="4.8" height="4.8" rx="1" />;
  }
}

export interface StatusMarkProps {
  status: StepRunStatus;
  /** Overrides the default English accessible label (i18n is a caller concern). */
  label?: string;
  size?: number;
}

export function StatusMark({
  status,
  label,
  size = 15,
}: StatusMarkProps): JSX.Element {
  const shape = SHAPE_BY_STATUS[status];
  const dashed = DASHED_RING.has(status);
  const accessibleLabel = label ?? DEFAULT_LABEL[status];
  return (
    <span
      className="status-mark"
      data-status={status}
      data-shape={shape}
      style={{ color: statusColor[status] }}
      role="img"
      aria-label={accessibleLabel}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.4" {...(dashed ? { strokeDasharray: "2.2 2.6" } : {})} />
        <Glyph shape={shape} />
      </svg>
    </span>
  );
}
