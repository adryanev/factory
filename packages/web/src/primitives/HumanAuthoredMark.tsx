import type { ReactNode } from "react";
import "./HumanAuthoredMark.css";

export interface HumanAuthoredMarkProps {
  /** The Principal (CONTEXT.md "Principal") who wrote it, e.g. "rangga". */
  by?: string;
  children?: ReactNode;
}

/**
 * The ONLY primitive allowed to render the --attention token
 * (tokens/colors.ts's humanWrittenInArtifactColor). Per spec.md "Bahasa
 * visual": "Warna `--attention` dipersempit maknanya jadi hanya 'ditulis
 * manusia ke dalam artefak'" — it marks *exclusively* content a human wrote
 * directly into an Artifact: an inline draft edit, an edited PRD section,
 * a decision row sourced from a human edit.
 *
 * Do not reach for --attention for anything else — not a warning, not an
 * awaiting-human state (that's StatusMark's `--status-awaiting-human`,
 * which deliberately uses --warning instead), not "this is the row you're
 * currently on". If a screen needs a different kind of emphasis, it needs a
 * different token, not this one with a different label.
 */
export function HumanAuthoredMark({
  by,
  children,
}: HumanAuthoredMarkProps): JSX.Element {
  const text = children ?? (by ? `ditulis ${by}` : "ditulis manusia");
  return (
    <span className="human-authored-mark" role="note">
      {text}
    </span>
  );
}
