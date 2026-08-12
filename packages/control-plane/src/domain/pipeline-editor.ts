/**
 * The visual Pipeline editor's control-plane surface (issue #20): turn a
 * parsed-and-validated Pipeline definition into a PR containing the YAML,
 * opened in the host repository. There is deliberately **no database draft
 * mode** — the repository stays the source of truth, the PR is the only
 * output, and testing a changed Pipeline is running its PR's branch (the
 * trigger path from `domain/runs.ts`).
 *
 * The interesting half of this issue is attribution: the clicking User has
 * **no User credential**. Git separates author from committer, and GitHub
 * attributes contributions to the author, so an installation token decides
 * *who may push*, never *who is written as having made the change* (ticket
 * 27):
 *
 * ```
 * author     = the clicking User <github-id>+<github-login>@users.noreply.github.com>
 * committer  = factory[bot]
 * push       = ad-hoc installation token, host repo only,
 *              contents:write + pull_requests:write, revoked after the operation
 * ```
 *
 * `users.noreply.github.com` is chosen because it always maps back to the
 * account for contribution purposes and never leaks a personal email.
 * OAuth user tokens are rejected by construction: no token is ever stored,
 * and the only credential minted is the installation token below.
 *
 * The commit is written through the Contents API (`GitHost.writeFile`) —
 * one file, no local clone. The branch name carries a client-generated
 * idempotency key, so a retried request re-writes the same branch, gets a
 * 422 that means "already there", and find-or-creates the same PR — the
 * issue #17 "422 treated as success" rule applied to the editor.
 *
 * Validation reuses the shared Zod schema (`validatePipelineDefinition`):
 * the editor is immediate feedback, the control plane's trigger gate
 * remains authoritative (spec: "Validasi mengikat hanya di control plane
 * saat trigger").
 *
 * `member` is sufficient (AC7) — a direct consequence of the `maintainer`
 * role being rejected: separating "write a Pipeline" from "run a Pipeline"
 * means nothing for an internal team. The PR the editor opens is **not** an
 * audit event (AC8): the PR itself is already a permanent, attributed
 * record on GitHub; recording it again would duplicate a record that lives
 * in a better place. Hence no `recordAuditEvent` call anywhere in this
 * file, deliberately.
 */
import { and, eq } from "drizzle-orm";
import { validatePipelineDefinition, type Id } from "@factory/shared";
import { githubAppInstallations, repositories, users } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { requireProjectMembership } from "./projects.js";
import { ContentConflictError, PullRequestConflictError, type RepoRef } from "./git-host.js";
import { DomainValidationError, NotFoundError } from "./errors.js";
import type { Principal } from "./principal.js";
import { formatValidationIssues } from "./runs.js";

/** The editor's token permission surface: exactly the two writes the operation makes — the file write and the PR. This is the first `pull_requests:write` use outside `kind: pull-request` (ticket 27: "pemakaian pertama `pull_requests:write` di luar `kind: pull-request`"). */
export const EDITOR_WRITE_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

/**
 * The bot identity every editor commit is committed as (issue #20, AC2:
 * "committer = identitas bot").
 *
 * Naming a committer costs the commit its signature, and that is the
 * accepted trade (issue #42, probed 2026-08-12): GitHub signs an
 * API-created commit only when the request names neither author nor
 * committer, in which case the commit is attributed wholly to the App's bot
 * — which is exactly what this issue exists to avoid. Changing this address
 * does not buy a signature back; every identity shape was probed. Editor
 * commits are unsigned, so branch protection requiring signed commits
 * rejects them (docs/operating.md).
 */
export const EDITOR_COMMITTER = { name: "factory[bot]", email: "factory[bot]@users.noreply.github.com" } as const;

/** The branch the editor's PR opens from. The `editId` suffix is the idempotency key. */
export const EDITOR_BRANCH_PREFIX = "factory/editor";

/** Branch-safe, lowercase — the same shape as a Pipeline Key, so an id can never collide with another ref character-wise. */
const EDIT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface EditorRepository {
  id: Id<"repository">;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface OpenEditorPullRequestInput {
  repositoryId: Id<"repository">;
  /** The file the YAML is written to in the host repo, e.g. `.factory/pipeline.yaml`. */
  pipelinePath: string;
  /** The serialized Pipeline definition — validated here with the same shared schema the trigger gate uses. */
  yaml: string;
  /** Client-generated idempotency key. Rides in the branch name: a retried request re-writes the same branch and adopts the same PR (422-as-success, issue #17's rule). */
  editId: string;
}

export interface EditorPullRequestResult {
  prNumber: number;
  prUrl: string;
  headBranch: string;
  /** The commit SHA the Contents API returned — what the PR's checks area reads. */
  commitSha: string;
}

/** The host-repo candidates the editor UI can lock onto (AC1: "scope UI terkunci di situ"): the Project's repositories, and nothing else. */
export async function listProjectRepositories(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
): Promise<EditorRepository[]> {
  await requireProjectMembership(deps, principal, projectId);
  const rows = await deps.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, projectId));
  return rows.map((row) => ({
    id: row.id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.defaultBranch,
  }));
}

/** The GitHub identity the author field needs — `null` for break-glass, which has no GitHub account (schema: `users.github_user_id`/`github_login` nullable). */
async function githubIdentity(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
): Promise<{ githubUserId: number; githubLogin: string } | null> {
  if (principal.kind !== "user") return null;
  const [row] = await deps.db.select().from(users).where(eq(users.principalId, principal.id));
  if (!row || row.githubUserId === null || row.githubLogin === null) return null;
  return { githubUserId: row.githubUserId, githubLogin: row.githubLogin };
}

/**
 * Opens the editor's PR. The whole flow is exactly three GitHub calls — mint
 * the narrow token, write the file, open the PR — and the token is revoked
 * in `finally`, on every path, success or failure (AC3: "dihapus setelah
 * selesai"). No DB write happens anywhere in this function (no draft mode).
 */
export async function openEditorPullRequest(
  deps: Pick<AppDeps, "db" | "gitHost">,
  principal: Principal,
  projectId: Id<"project">,
  input: OpenEditorPullRequestInput,
): Promise<EditorPullRequestResult> {
  // AC7: `member` is sufficient — no admin, and no maintainer role exists
  // (rejected by design: "memisahkan 'menulis Pipeline' dari 'menjalankan
  // Pipeline' tidak berarti untuk tim internal").
  await requireProjectMembership(deps, principal, projectId);

  if (!EDIT_ID_PATTERN.test(input.editId)) {
    throw new DomainValidationError(
      "edit_id_invalid",
      `editId must match [a-z0-9][a-z0-9._-]{0,63} — it names the branch and must stay branch-safe`,
    );
  }

  // The author is the clicking User — the whole point of this issue's
  // attribution design. A principal without a GitHub identity (break-glass)
  // cannot be attributed, so it is rejected here rather than silently
  // opening a PR under a fake author.
  const identity = await githubIdentity(deps, principal);
  if (!identity) {
    throw new DomainValidationError(
      "github_identity_required",
      "opening an editor PR requires a GitHub-linked account: the commit author is attributed to the clicking user via users.noreply.github.com, and a break-glass account has no GitHub identity to attribute",
    );
  }

  const [repository] = await deps.db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, input.repositoryId), eq(repositories.projectId, projectId)));
  if (!repository) {
    throw new NotFoundError("repository", input.repositoryId);
  }
  const [installation] = await deps.db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.id, repository.githubAppInstallationId));
  if (!installation) {
    throw new Error(`repository ${repository.id} references a missing github app installation`);
  }

  // AC6: same shared Zod schema, immediate feedback. The binding gate
  // remains the trigger-time validation in `domain/runs.ts`.
  const validation = validatePipelineDefinition(input.yaml);
  if (!validation.valid) {
    throw new DomainValidationError("pipeline_definition_invalid", formatValidationIssues(validation.issues));
  }

  const repo: RepoRef = { owner: repository.owner, name: repository.name };
  const branch = `${EDITOR_BRANCH_PREFIX}/${input.editId}`;
  const base = repository.defaultBranch;
  const author = {
    name: identity.githubLogin,
    email: `${identity.githubUserId}+${identity.githubLogin}@users.noreply.github.com`,
  };

  const token = await deps.gitHost.mintInstallationToken(repo, installation.installationId, EDITOR_WRITE_PERMISSIONS);
  try {
    // The Contents API writes to a branch, it does not create one: a write to
    // a branch that does not exist yet is a 404 (issue #39). Cut it first —
    // cutting a branch that already exists is success, so a retried request
    // lands on its own branch and carries on.
    await deps.gitHost.createBranch(repo, branch, base, token.token);

    // The Contents API replaces a file only when handed the blob SHA it is
    // replacing (issue #41), and the editor's usual case is exactly that: a
    // pipeline file that already exists on the branch just cut from base.
    // Reading it here — after the cut — means a retried request sees what
    // its own earlier attempt wrote. `null` is the new-file case.
    const existingSha = await deps.gitHost.readFileSha(repo, input.pipelinePath, branch, token.token);

    let commitSha: string;
    try {
      const written = await deps.gitHost.writeFile(repo, {
        path: input.pipelinePath,
        content: input.yaml,
        branch,
        message: `factory: update ${input.pipelinePath} (visual editor)`,
        author,
        committer: EDITOR_COMMITTER,
        ...(existingSha === null ? {} : { sha: existingSha }),
      }, token.token);
      commitSha = written.sha;
    } catch (error) {
      if (!(error instanceof ContentConflictError)) throw error;
      // The file changed between the SHA read and the write. Proceed to
      // find-or-create: the branch name is the idempotency key, so the PR
      // below is adopted rather than duplicated — the issue #17 rule.
      commitSha = "";
    }

    // Find-then-create, issue #17's idempotency shape: adopt an open PR for
    // this head/base pair; a 422 create is success-by-adoption.
    let pr = await deps.gitHost.findOpenPullRequest(repo, branch, base, token.token);
    if (pr === null) {
      try {
        pr = await deps.gitHost.createPullRequest(
          repo,
          {
            title: `factory: pipeline ${input.pipelinePath} (visual editor)`,
            body: [
              `Pipeline definition updated through the factory visual editor.`,
              ``,
              `- file: ${input.pipelinePath}`,
              `- author: ${identity.githubLogin} (via users.noreply.github.com)`,
              `- committer: ${EDITOR_COMMITTER.name}`,
              ``,
              `The control plane validates this definition against the shared Pipeline schema at trigger time; this PR's branch is how you test it before it lands on ${base}.`,
            ].join("\n"),
            head: branch,
            base,
          },
          token.token,
        );
      } catch (error) {
        if (!(error instanceof PullRequestConflictError)) throw error;
        // Idempotency half two: a raced create GitHub refused with 422 is
        // success-by-adoption — re-find to get the number. A 422 that does
        // not resolve to a real PR is a genuine failure.
        pr = await deps.gitHost.findOpenPullRequest(repo, branch, base, token.token);
        if (pr === null) {
          throw new Error("github pull request create returned 422 but no matching open pull request was found");
        }
      }
    }

    return {
      prNumber: pr.number,
      prUrl: pr.htmlUrl,
      headBranch: branch,
      // The write's own SHA when this request created it; the PR's head SHA
      // when this request only adopted an existing branch.
      commitSha: commitSha !== "" ? commitSha : pr.headSha,
    };
  } finally {
    // AC3 teardown: the ad-hoc token dies here, on every path. A failure to
    // revoke is a security condition and propagates — the PR itself already
    // exists and a retry adopts it.
    await deps.gitHost.revokeInstallationToken(token.token);
  }
}
