/**
 * Literal redaction for agent-captured text (log chunks today, artifacts in
 * a later issue). Best-effort only: it hides the *exact* strings it is given
 * and nothing else (spec: "Redaksi literal best-effort sebelum upload, sama
 * persis dengan redaksi Artifact dan tidak lebih luas"). Deliberately no
 * regex, no entropy detection, no "looks like a key" heuristics — those do
 * not improve any guarantee, they only make readers believe one exists.
 *
 * This is a cosmetic leak-stopper, **NOT a security control**. The security
 * boundary of the system is default-deny egress from the sandbox; redaction
 * is documented as such in the log ADR (docs/adr). A secret that takes a
 * form the literal list does not cover (a newline-split secret, a
 * base64-of-it) is redacted never — by design.
 */
export const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Builds a redactor that replaces every exact occurrence of each given secret
 * with `REDACTION_PLACEHOLDER`. Longest secret first, so a secret that is a
 * substring of another is replaced as one unit rather than half-eaten by the
 * shorter match. Returns the identity function for an empty list — no
 * allocation, no transformation.
 */
export function createLiteralRedactor(secrets: ReadonlyArray<string>): (text: string) => string {
  const ordered = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (ordered.length === 0) {
    return (text) => text;
  }
  return (text) => {
    let out = text;
    for (const secret of ordered) {
      out = out.split(secret).join(REDACTION_PLACEHOLDER);
    }
    return out;
  };
}
