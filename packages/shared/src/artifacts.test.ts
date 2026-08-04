import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS, isArtifactKind, normalizeArtifactKey } from "./artifacts.js";

describe("normalizeArtifactKey", () => {
  it("lowercases and collapses punctuation into the KEY_PATTERN shape", () => {
    expect(normalizeArtifactKey("diff")).toBe("diff");
    expect(normalizeArtifactKey("PRD")).toBe("prd");
    expect(normalizeArtifactKey("My Report.md")).toBe("my-report.md");
    expect(normalizeArtifactKey("  leading dots..")).toBe("leading-dots");
    expect(normalizeArtifactKey("laporan Final v2")).toBe("laporan-final-v2");
  });

  it("keeps dots and underscores as separators", () => {
    expect(normalizeArtifactKey("plan.v2_final")).toBe("plan.v2_final");
  });

  it("caps the length at 64 characters like KEY_PATTERN", () => {
    const long = "a".repeat(120);
    expect(normalizeArtifactKey(long)).toHaveLength(64);
  });

  it("falls back to a stable slug when nothing survives normalization", () => {
    expect(normalizeArtifactKey("!!!")).toBe("artifact");
    expect(normalizeArtifactKey("")).toBe("artifact");
  });
});

describe("ARTIFACT_KINDS", () => {
  it("is the closed six-kind set the UI must cover", () => {
    expect(ARTIFACT_KINDS).toEqual(["diff", "transcript", "document", "structured", "command-output", "binary"]);
  });

  it("isArtifactKind discriminates the closed set", () => {
    expect(isArtifactKind("diff")).toBe(true);
    expect(isArtifactKind("binary")).toBe(true);
    expect(isArtifactKind("video")).toBe(false);
  });
});
