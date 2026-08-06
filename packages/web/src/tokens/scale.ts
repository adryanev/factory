/**
 * Radius, shadow, type and motion accessors — see tokens/tokens.css for the
 * source values and provenance (grilling-ui/index.html lines 26-40).
 */
export const radius = {
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  xl: "var(--radius-xl)",
} as const;

export const shadow = {
  xs: "var(--shadow-xs)",
  sm: "var(--shadow-sm)",
  md: "var(--shadow-md)",
  lg: "var(--shadow-lg)",
} as const;

export const fontSize = {
  xs: "var(--fs-xs)",
  sm: "var(--fs-sm)",
  base: "var(--fs-base)",
  lg: "var(--fs-lg)",
  xl: "var(--fs-xl)",
  xxl: "var(--fs-2xl)",
} as const;

export const font = {
  sans: "var(--sans)",
  display: "var(--display)",
  mono: "var(--mono)",
} as const;

export const motion = {
  ease: "var(--ease)",
  duration: "var(--dur)",
} as const;
