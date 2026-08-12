# 0004 — Visual Pipeline editor: PR as the only output, user-attributed, bot-committed

Status: Accepted (implemented by issue #20 — Editor Pipeline visual)

## Context

A developer composes a Pipeline visually in the web UI and gets a **PR with
the YAML file** in the host repository — never a database row. The direction
is always visual → code, never the reverse, and there is no draft mode:
testing a changed Pipeline is running its PR's branch. The interesting half
is attribution: the clicking user has **no user credential** (PATs were
deleted by ticket 27 — no consumers), yet the commit must be credited to
them.

## Decisions

### The editor's only write is a PR; nothing is stored; no audit event

`POST /projects/{id}/pipeline-editor` validates the serialized definition
and opens a PR containing the YAML. No table is written, there is no draft
endpoint, and the editor PR is **not** an audit event — the PR itself is
already a permanent, attributed record on GitHub (AC8). The editor is
reached at `GET /projects/{id}/repositories`, which lists only the
Project's repositories: the UI scope is locked to the host repo.

### Author = clicking user via `users.noreply.github.com`; committer = `factory[bot]`

Git separates author from committer and GitHub attributes contributions to
the author, so an installation token decides *who may push*, never *who is
written as having made the change*:

```
author     = <githubUserId>+<githubLogin>@users.noreply.github.com
committer  = factory[bot] <factory[bot]@users.noreply.github.com>
```

`users.noreply.github.com` always maps back to the account for contribution
purposes and never leaks a personal email. A principal without a GitHub
identity (the break-glass account) cannot be attributed and is rejected
with `github_identity_required` — the break-glass account has no GitHub id
to put in the address. `member` is sufficient; there is no `maintainer`
role to add.

### One Contents-API call instead of the Git Data pipeline; the branch name is the idempotency key

The editor writes one file, so there is no reason to build a worktree: the
Contents API (`PUT /contents/{path}`) creates blob, tree, commit, and ref
in a single authenticated call, with `author`/`committer` objects inline.
A retried request carries the same client-generated `editId` (an `edit_`
prefixed id — a table-less entry in `ID_PREFIXES`), the branch name embeds
it (`factory/editor/<editId>`), and GitHub's 422 on the re-write is treated
as success-by-adoption: the PR create 422s in turn and the open PR is
re-found and adopted — the issue #17 rule extended to the editor. Different
`editId`s open different PRs, which is the correct semantics (each submit
is its own change).

### The ad-hoc token is minted, used, and revoked; never a user token

Exactly one installation token per request, `repository_ids` narrowed to
the host repo, permissions `{ contents: write, pull_requests: write }` —
the first `pull_requests:write` use outside `kind: pull-request` (ticket
27) — and revoked via `DELETE /installation/token` (the token authenticates
its own revocation, no App credential) in a `finally`, on success and
failure alike. A revocation failure propagates: it is a security condition,
and the retry path re-adopts the PR.

### The "Verified" claim (AC5) — probed, and false: editor commits are unsigned

Spec.md's Further Notes flagged that "commit lewat API dengan installation
token muncul sebagai `Verified`" had never been re-checked. The check is a
probe: `pnpm --filter @factory/control-plane probe:editor-verified`
(`packages/control-plane/scripts/probe-editor-verified.ts`) mints the
editor's token, writes one file through the same `writeFile` path, reads
the commit's `verification` object back from the Git Data API, and prints
`verified`/`reason`.

**Result (run 2026-08-12 against app `factory-localhost`, installation
153069158, repo `adryanev/factory`): the claim is false.** The commit came
back `verified: false`, reason `unsigned`. Issue #42 then probed the four
ways a `PUT /contents/{path}` request can name an identity, plus the
request that names none:

| what the request sends as author/committer | `verification` |
| --- | --- |
| committer `factory[bot] <factory[bot]@users.noreply.github.com>` | `unsigned` |
| committer = the App's own bot account, `<bot-id>+factory-localhost[bot]@users.noreply.github.com` | `unsigned` |
| committer = the App's bot account without the numeric id | `unsigned` |
| author sent, committer omitted (GitHub fills in the App bot) | `unsigned` |
| **neither author nor committer sent** | **`verified`** |

GitHub signs an API-created commit only when the request supplies *no*
identity at all — it then writes `author` as the App's bot and `committer`
as `GitHub <noreply@github.com>` and signs that with its own key. Any
explicit identity, including the App's own bot, is written through verbatim
and left unsigned.

So `Verified` and "author = the clicking user" are mutually exclusive on
this path, and the choice is not close: attribution *is* the feature
(AC2), signature is not. **Editor commits are unsigned, by decision.** The
operational consequence is a real one and is documented in
`docs/operating.md`: a host repository whose branch protection requires
signed commits rejects the editor's commits outright.

### The fragile paths are pinned by backend tests (issue #36)

Issue #36's verification found the editor's route/domain layer carried no
backend tests. It now does, in `test/seam1/pipeline-editor.test.ts` over
the seam-1 rig with the fake `GitHost`: the PR lands in the host repo only,
attribution is author=user / committer=bot, the token is minted with
exactly the two editor permissions and revoked on success and on a
mid-flight failure (`failNextCreates`), invalid definitions are rejected
before any GitHub call, non-members get 403, foreign repositories 404, and
a retried request with the same `editId` adopts the same PR through both
422-as-success halves (Contents write and PR create).

## Consequences

- The editor is a PR generator, never a second storage: no `pipelines`
  table, no draft state, no audit rows, no draft-restore code path to
  maintain.
- Attribution is honest by construction: a user token is structurally
  impossible (nothing user-credentialed is ever stored or minted).
- Idempotency reuses GitHub's own constraints instead of a new key column —
  the branch name *is* the key — matching the codebase's "nol kunci baru"
  rule.
- Editor commits are unsigned, and no address change fixes that. A host
  repository that requires signed commits cannot use the editor — the one
  deployment constraint this feature imposes.
- The Contents API surface (author/committer, 422 semantics) is pinned in
  the `GitHost` seam and its fake, so the seam-1 tests prove attribution,
  repo scope, token teardown, and the PR response without ever dialing out.
