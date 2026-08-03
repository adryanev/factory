import type { Document, LineCounter } from "yaml";
import type { z } from "zod";

/** A single validation problem, always pointing at a line in the source text. */
export interface ValidationIssue {
  message: string;
  /** Zod-style path into the parsed document, e.g. ["steps", "implement", "branchesFrom"]. */
  path: (string | number)[];
  /** 1-based line number, or null if the path could not be located in the source. */
  line: number | null;
  /** 1-based column number, or null under the same condition. */
  column: number | null;
}

/**
 * Walks a YAML Document following a Zod issue path and returns the range of
 * the deepest node it could resolve. Falls back to the last node it did
 * resolve when the path runs past what exists in the document (e.g. a
 * superRefine issue pointing at a field that is absent, such as a missing
 * `concurrency:`) — an error must still point somewhere useful.
 */
function locateNode(doc: Document, path: (string | number)[]): { node: unknown; range: readonly [number, number, number] } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = doc.contents;
  let lastRanged: { node: unknown; range: readonly [number, number, number] } | null = null;

  const remember = () => {
    if (current && Array.isArray(current.range)) {
      lastRanged = { node: current, range: current.range };
    }
  };
  remember();

  for (const segment of path) {
    if (current == null) break;

    if (typeof segment === "number") {
      // YAMLSeq
      const items = current.items;
      if (!Array.isArray(items) || items[segment] === undefined) break;
      current = items[segment];
      remember();
      continue;
    }

    // YAMLMap: find the Pair whose key matches `segment`, descend into its value.
    const items = current.items;
    if (!Array.isArray(items)) break;
    const pair = items.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p?.key?.value === segment
    );
    if (!pair) break;
    // Prefer the pair's own range (covers "key: value") when we cannot
    // descend further; otherwise descend into the value for the next segment.
    if (pair.value !== null && pair.value !== undefined) {
      current = pair.value;
      remember();
    } else if (Array.isArray(pair.range)) {
      lastRanged = { node: pair, range: pair.range };
      break;
    } else {
      break;
    }
  }

  return lastRanged;
}

/**
 * Converts one Zod issue into a line-located ValidationIssue by resolving
 * its path against the source YAML Document.
 */
export function locateIssue(
  doc: Document,
  lineCounter: LineCounter,
  issue: z.ZodIssue
): ValidationIssue {
  const path = issue.path as (string | number)[];
  const located = locateNode(doc, path);

  if (!located) {
    return { message: issue.message, path, line: null, column: null };
  }

  const [start] = located.range;
  const pos = lineCounter.linePos(start);
  return { message: issue.message, path, line: pos.line, column: pos.col };
}
