/**
 * Artifact kinds — a closed enum, one entry per renderer the UI must cover
 * (spec: "kind adalah enum tertutup (diff, transcript, document, structured,
 * command-output, binary)"). `content_type` never chooses the renderer; the
 * `kind` does (spec: "media_type berdiri di sampingnya hanya untuk header
 * unduhan, tidak pernah memilih renderer"). Adding a type is one enum value
 * + one renderer, no schema migration.
 *
 * Same closed-set-as-`text`+`CHECK` pattern as Question's `kind` (spec:
 * "Himpunan nilai tertutup memakai text + CHECK, bukan pgEnum") — the set is
 * stored on the `artifacts` table as a CHECK, and this constant is the
 * single source both the Runner's uploader and the control plane's wire
 * validation read from.
 */
export const ARTIFACT_KINDS = [
  "diff",
  "transcript",
  "document",
  "structured",
  "command-output",
  "binary",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * Slug-normalizes an artifact key the Runner reports (spec: "Stabilitas key
 * lintas giliran hanya konvensi, dimitigasi normalisasi slug (di sini
 * keunikan memang tidak pernah dijanjikan — berbeda dari Key fan-out)").
 * "PRD", "My Report.md", "laporan Final v2" all become lowercase slugs so a
 * per-key history query across turns stays linkable. Uniqueness is NEVER
 * promised across StepRuns — two turns whose keys diverge simply break the
 * chain, silently, and nothing complains (the deliberate, stated trade of
 * "Artifact tidak punya kontrak").
 *
 * The output respects the same shape as `KEY_PATTERN` (lowercase
 * `[a-z0-9][a-z0-9._-]{0,63}`) so a normalized key is always a safe git-ref
 * component too — but unlike fan-out Keys, this is a *stored-key
 * transformation*, not a validation that rejects the raw value.
 */
export function normalizeArtifactKey(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "artifact";
}
