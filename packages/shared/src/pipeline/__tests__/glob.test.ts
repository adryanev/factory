import { describe, expect, it } from "vitest";
import { anyGlobMatches, globMatches } from "../glob.js";

describe("globMatches", () => {
  it("matches literals exactly, anchored at both ends", () => {
    expect(globMatches("main", "main")).toBe(true);
    expect(globMatches("main", "feature/main")).toBe(false);
    expect(globMatches("main", "maintenance")).toBe(false);
  });

  it("matches `*` within one segment only", () => {
    expect(globMatches("feat/*", "feat/alpha")).toBe(true);
    expect(globMatches("feat/*", "feat/alpha/beta")).toBe(false);
    expect(globMatches("*.yaml", "pipeline.yaml")).toBe(true);
    expect(globMatches("*.yaml", "pipeline.yml")).toBe(false);
  });

  it("matches `**` across segments", () => {
    expect(globMatches("docs/**", "docs/")).toBe(true);
    expect(globMatches("docs/**", "docs/a/b.txt")).toBe(true);
    expect(globMatches("docs/**", "src/docs/a.md")).toBe(false);
    expect(globMatches("**/*.yaml", "a/b/c.yaml")).toBe(true);
  });

  it("matches `?` as exactly one character within a segment", () => {
    expect(globMatches("feat/x?", "feat/x1")).toBe(true);
    expect(globMatches("feat/x?", "feat/x12")).toBe(false);
    expect(globMatches("feat/x?", "feat/x/")).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(globMatches("a.b", "a.b")).toBe(true);
    expect(globMatches("a.b", "aXb")).toBe(false);
    expect(globMatches("(hotfix)", "(hotfix)")).toBe(true);
  });
});

describe("anyGlobMatches", () => {
  it("returns true when any pattern matches", () => {
    expect(anyGlobMatches(["main", "feat/**"], "feat/ui")).toBe(true);
    expect(anyGlobMatches(["main", "feat/**"], "release")).toBe(false);
  });

  it("returns false for an empty pattern list", () => {
    expect(anyGlobMatches([], "main")).toBe(false);
  });
});
