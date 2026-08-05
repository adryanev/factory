/**
 * The only wildcard language `on:` trigger filters speak (spec: "Automation"
 * — `on: { push: { branches: [...] } }` and `on: { push: { paths: [...] } }`).
 * Deliberately not minimatch: three operators, no dependencies, and a
 * documented boundary — a pattern is matched against a *whole* value (branch
 * name, or a changed file path), never a substring.
 *
 * Operators:
 *   `**`  any sequence of characters, including `/`
 *   `*`   any sequence of characters within one path segment (never `/`)
 *   `?`   exactly one character (never `/`)
 *
 * Everything else is a literal. `**` and `/` are not special-cased beyond
 * that: `docs/**` matches `docs/a/b.txt` because `**` swallows the slash.
 */

function escapeRegExpLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Converts one `on:` filter pattern into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeRegExpLiteral(ch);
  }
  return new RegExp(`^${out}$`);
}

/** True when `value` matches the whole-value pattern (anchored). */
export function globMatches(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

/** True when `value` matches at least one of the patterns. */
export function anyGlobMatches(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => globMatches(pattern, value));
}
