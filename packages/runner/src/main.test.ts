import { describe, expect, it } from "vitest";
import { describeRunnerScaffold } from "./main.js";

describe("runner scaffold", () => {
  it("imports @factory/shared as a workspace package", () => {
    expect(describeRunnerScaffold()).toContain("shared id validator loaded: true");
  });
});
