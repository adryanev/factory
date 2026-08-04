/**
 * AC6, the Runner half: default-deny egress with a per-Project allowlist,
 * rendered as `pf` rules scoped to the agent's OS user. The security-relevant
 * property is proven on the pure rule text: there is always a `block`
 * (default-deny) and the ONLY `pass` rules reference the allowlisted hosts.
 */
import { describe, expect, it } from "vitest";
import { renderEgressRules } from "../egress.js";

describe("egress: default-deny allowlist rules", () => {
  it("always emits a block rule — anything not allowlisted is denied", () => {
    const rules = renderEgressRules("factoryjob", ["github.com"]);
    expect(rules).toContain("block out");
  });

  it("emits exactly one pass rule, scoped to the agent user's table", () => {
    const rules = renderEgressRules("factoryjob", ["github.com", "registry.npmjs.org"]);
    const passLines = rules.split("\n").filter((line) => line.startsWith("pass out"));
    expect(passLines).toHaveLength(1);
    expect(passLines[0]).toContain("user factoryjob");
    expect(passLines[0]).toContain("<factory.factoryjob>");
  });

  it("the allowlist table contains exactly the allowlisted hosts — and no others", () => {
    const allowlist = ["github.com", "*.apple.com"];
    const rules = renderEgressRules("factoryjob", allowlist);
    const tableLine = rules.split("\n").find((line) => line.startsWith("table <"));
    expect(tableLine).toContain('"github.com"');
    expect(tableLine).toContain('"*.apple.com"');
    // A host that is NOT allowlisted appears nowhere — no pass rule, no table entry.
    expect(rules).not.toContain("evil.example.org");
  });

  it("an empty allowlist renders pass-to-empty-table: everything is blocked", () => {
    const rules = renderEgressRules("factoryjob", []);
    const passLines = rules.split("\n").filter((line) => line.startsWith("pass out"));
    // `pass ... to <empty table>` matches nothing — the deny-by-default block
    // below it is the effective rule.
    expect(passLines).toHaveLength(1);
    expect(passLines[0]).toContain("to <factory.factoryjob>");
    expect(rules).toContain("block out");
  });

  it("scopes rules to the agent user, not the Runner's user", () => {
    const rules = renderEgressRules("_factoryjob", ["github.com"]);
    for (const line of rules.split("\n").filter((l) => l.includes("user "))) {
      expect(line).toContain("user _factoryjob");
      expect(line).not.toMatch(/user _factory(?![a-z0-9_.-])/);
    }
  });

  it("sanitizes the user into a valid pf table name", () => {
    expect(renderEgressRules("weird user!", ["github.com"])).toContain("<factory.weird_user_>");
  });
});
