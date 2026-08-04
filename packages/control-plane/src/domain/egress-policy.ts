/**
 * The built-in egress allowlist (ticket 10: "git host, endpoint API agent,
 * registry paket; untuk macOS tambah `developer.apple.com`, `*.apple.com`,
 * `cdn.cocoapods.org`"). Default-deny is the policy: anything not in a
 * Project's allowlist is denied egress. A project may replace this
 * wholesale; there is deliberately no merge — a narrower list is a stricter
 * sandbox.
 *
 * This constant lives in its own module (no `db/schema` import) so the
 * `projects` table can use it as its column default without a schema ↔ domain
 * import cycle.
 */
export const DEFAULT_EGRESS_ALLOWLIST: string[] = [
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "developer.apple.com",
  "*.apple.com",
  "cdn.cocoapods.org",
];
