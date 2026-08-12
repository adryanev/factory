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
 *   GITHUB_REPO_BASE_BRANCH=<default branch> \
 *   pnpm --filter @factory/control-plane probe:editor-verified
 *
 * It mints the same ad-hoc installation token the editor uses and makes the
 * editor's three write calls in the editor's order (cut branch, read blob
 * sha, write the file; author = probe user, committer = factory[bot]), then
 * reads the commit's `verification` object back from the Git Data API and
 * prints `verified` and `reason`. The probe branch is left behind for
 * inspection — delete it after reading the output.
 *
 * RESULT (documented at implementation time, issue #20): RUN 2026-08-12
 * against app factory-localhost (id 4557244), installation 153069158, repo
 * adryanev/factory. The commit was created, but the claim did NOT hold:
 * verification.verified = false, reason "unsigned".
 *
 * Issue #42 followed that up by probing every identity shape the Contents
 * API accepts, on the same installation. All four that name an identity came
 * back unsigned: the editor's factory[bot] address, the App's own bot
 * account with and without its numeric id prefix, and author-only with the
 * committer omitted. Only the request that names neither author nor
 * committer is signed — GitHub then writes author = the App's bot and
 * committer = GitHub <noreply@github.com>. Signature and user attribution
 * are therefore mutually exclusive here, and issue #20 chooses attribution:
 * editor commits are unsigned by decision (ADR-0004).
 *
 * The run also turned up three bugs, each now fixed and covered by test:
 * the Contents API does not create the branch it is handed (#39), a write
 * over an existing file must carry that file's blob sha (#41), and
 * matching-refs returns a plain array rather than { refs: [...] } (#39).
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

  const base = requiredEnv("GITHUB_REPO_BASE_BRANCH");
  const branch = `factory/probe/editor-verified-${Date.now()}`;
  const path = "factory-probe/editor-verified.txt";
  try {
    // The same three calls the editor makes, in the same order: cut the
    // branch (the Contents API never does, issue #39), read the blob sha of
    // whatever is at the path (issue #41), then write.
    await host.createBranch(repo, branch, base, token.token);
    const existingSha = await host.readFileSha(repo, path, branch, token.token);
    const { sha } = await host.writeFile(
      repo,
      {
        path,
        content: `probe: commit created through the Contents API with an installation token (${new Date().toISOString()})\n`,
        branch,
        message: "factory: editor-verified probe",
        author: { name: "factory-probe", email: "1+factory-probe@users.noreply.github.com" },
        committer: EDITOR_COMMITTER,
        ...(existingSha === null ? {} : { sha: existingSha }),
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
