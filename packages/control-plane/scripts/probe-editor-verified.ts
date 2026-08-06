/**
 * Probe for issue #20's verification item (AC5): the claim that a commit
 * created through the GitHub API with an installation token is signed by
 * GitHub and surfaces as `Verified` — marked in spec.md's Further Notes as
 * "belum diverifikasi ulang dan harus dicek saat implementasi".
 *
 * This probe is the check. Run it with GitHub App credentials and a
 * repository the App is installed on:
 *
 *   GITHUB_APP_ID=<id> \
 *   GITHUB_APP_PRIVATE_KEY_FILE=app.pem \
 *   GITHUB_INSTALLATION_ID=<installation id> \
 *   GITHUB_REPO_OWNER=<owner> \
 *   GITHUB_REPO_NAME=<name> \
 *   pnpm --filter @factory/control-plane probe:editor-verified
 *
 * It mints the same ad-hoc installation token the editor uses, writes one
 * file through the same Contents-API `writeFile` path (author = probe user,
 * committer = factory[bot]), reads the commit's `verification` object back
 * from the Git Data API, and prints `verified` and `reason`. The probe
 * branch is left behind for inspection — delete it after reading the output.
 *
 * RESULT (documented at implementation time, issue #20): NOT RUN HERE. This
 * environment has no GitHub App credentials, no installation, and no target
 * repository reachable, so the claim could not be empirically re-checked —
 * it rests on GitHub's documented behavior that commits created via the
 * REST API are signed by GitHub's own key and rendered `Verified`. Run this
 * probe against a real installation to settle it.
 */
import { readFileSync } from "node:fs";
import { createGithubHost } from "../src/domain/git-host.js";
import { EDITOR_COMMITTER } from "../src/domain/pipeline-editor.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required — see the probe header for the full invocation.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const appId = Number(requiredEnv("GITHUB_APP_ID"));
  const privateKey = readFileSync(requiredEnv("GITHUB_APP_PRIVATE_KEY_FILE"), "utf-8");
  const installationId = Number(requiredEnv("GITHUB_INSTALLATION_ID"));
  const repo = {
    owner: requiredEnv("GITHUB_REPO_OWNER"),
    name: requiredEnv("GITHUB_REPO_NAME"),
  };

  const host = createGithubHost({ appId, privateKey });
  const token = await host.mintInstallationToken(repo, installationId, { contents: "write", pull_requests: "write" });

  const branch = `factory/probe/editor-verified-${Date.now()}`;
  const path = "factory-probe/editor-verified.txt";
  try {
    const { sha } = await host.writeFile(
      repo,
      {
        path,
        content: "probe: commit created through the Contents API with an installation token\n",
        branch,
        message: "factory: editor-verified probe",
        author: { name: "factory-probe", email: "1+factory-probe@users.noreply.github.com" },
        committer: EDITOR_COMMITTER,
      },
      token.token,
    );

    // The claim is about the commit's signature state — read it back from the
    // Git Data API (`verification` is returned by GET /git/commits/:sha).
    const response = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.token}` } },
    );
    if (!response.ok) {
      console.error(`reading the probe commit failed: HTTP ${response.status}`);
      process.exit(1);
    }
    const commit = (await response.json()) as {
      verification: { verified: boolean; reason: string; signature: string | null };
    };
    console.log(JSON.stringify({ sha, branch, verification: commit.verification }, null, 2));
    console.log(
      commit.verification.verified
        ? "CLAIM CONFIRMED: the API-created commit is verified."
        : `CLAIM UNCONFIRMED: verification.verified is false (reason: ${commit.verification.reason}).`,
    );
  } finally {
    await host.revokeInstallationToken(token.token);
    console.log(`token revoked; probe branch '${branch}' left in place — delete it after inspecting.`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
