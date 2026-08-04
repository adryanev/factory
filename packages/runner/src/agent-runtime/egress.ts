/**
 * Egress default-deny, the Runner's half of AC6: the Project allowlist rides
 * the `/claim` payload (control-plane), and here it is turned into firewall
 * rules scoped to the agent's OS user — `pf` on macOS, the platform
 * `exec:host` targets (ticket 10: "Ini juga yang membuat `pf` bisa di-scope
 * ke user agent untuk egress").
 *
 * The security-relevant part is `renderEgressRules`: a pure function whose
 * output is asserted in tests to be *deny by default* (a `block` rule) with
 * the *only* `pass` rules being the allowlisted hostnames, scoped to the
 * agent user. Real `pf` needs root and an anchor file, so the privileged
 * install (`pfctl -a ... -f ...`) sits behind the injectable `EgressControl`
 * seam — fakes prove the calls; the rule text is proven directly.
 *
 * SNI-style hostname matching is done by `pf`'s hostname tables (the table
 * resolves each allowlisted host, including `*.` wildcards), without any
 * TLS MITM.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A pf table/rule name scoped per agent user; pf allows `[a-zA-Z0-9_.-]`. */
function tableName(user: string): string {
  return `factory.${user.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

/**
 * Renders a `pf` anchor snippet: a persistent hostname table of the
 * allowlist, a `block` (default-deny) rule, and `pass` rules that reference
 * ONLY that table, all scoped to `user` — the separate OS user the agent
 * runs as (AC7), so the rules can't be escaped by another user's process.
 * An empty allowlist renders a `pass` to an empty table: everything is
 * blocked, which is exactly default-deny.
 */
export function renderEgressRules(user: string, allowlist: string[]): string {
  const table = tableName(user);
  const hosts = allowlist.map((host) => JSON.stringify(host)).join(", ");
  return [
    `table <${table}> persist { ${hosts} }`,
    `block out proto { tcp udp } user ${user} all`,
    `pass out proto { tcp udp } user ${user} to <${table}>`,
    "",
  ].join("\n");
}

/** The host-side enforcement seam. `apply` installs the allowlist rules for `user`; `remove` tears them down at teardown. */
export interface EgressControl {
  /** Returns a handle identifying the installed rules, for `remove`. */
  apply(user: string, allowlist: string[]): Promise<string>;
  remove(handle: string): Promise<void>;
}

/**
 * Real implementation over `pfctl` (macOS). Requires root, so it is
 * constructed but never exercised in the test suite — the tests prove the
 * rule *text* (default-deny, allowlist-only) and the seam's call shape via
 * fakes. The host layer resolves `user` the same way `pf` does: by name.
 */
export function createPfEgressControl(): EgressControl {
  return {
    async apply(user, allowlist) {
      const anchor = tableName(user);
      // `pfctl -a <anchor> -f -` reads the anchor rules from stdin.
      const child = spawn("pfctl", ["-a", anchor, "-f", "-"], { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(renderEgressRules(user, allowlist));
      child.stdin.end();
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`pfctl exited ${code} installing egress rules for user '${user}'`));
        });
      });
      return anchor;
    },
    async remove(handle) {
      try {
        await execFileAsync("pfctl", ["-a", handle, "-F", "all"]);
      } catch {
        // Best-effort teardown — the anchor may already be gone.
      }
    },
  };
}
