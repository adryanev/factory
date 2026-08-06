# 0002 — Artifacts: no contract, upload-before-record, and quota at URL-mint time

Status: Accepted (implemented by issue #10 — Artifact)

## Context

A StepRun produces things humans want to read after it ends — diffs,
agent-conversation transcripts, markdown documents, command output, binary
files — and the UI must open them without anyone checking out a branch. The
design is shaped by one decision that comes first and never gets reopened:
**Artifact tidak punya kontrak** (spec: "Artifact dan blob"). The Runner
reports freely, a Step declares no artifact list, and a permanently-failed
upload never fails the StepRun. "Step ini harus menghasilkan X" is written in
the Output schema, not in an artifact list. The one-sentence rule: *yang
tidak dikonsumsi siapa pun boleh hilang; yang menggerakkan Graph tidak boleh
masuk tanpa diperiksa.*

This ADR records the decisions that follow from that, and how they extend —
rather than fork — the log path ADR-0001 already established (Garage, minted
presigned URLs, control plane never holds a byte, metadata recorded after
upload).

## Decisions

### Artifact metadata rides `POST /result`; the commit point is push → upload → record

The turn's commit point is `push branch → unggah semua blob → POST result`
(spec, verbatim). Artifact metadata is part of the *final* request, committed
in the same transaction as the row update, so an artifact batch that is
refused voids the whole turn ("Output yang ditolak membuat seluruh giliran
seolah tidak pernah terjadi"). The invariant that makes this honest is the
order the Runner follows: the blob is PUT to Garage before `/result`, and only
the successfully-uploaded subset is ever listed. **Baris Artifact ada ⇒ blob
pasti ada.** Only a `succeeded` outcome records artifacts; a failed turn's
branch is an orphan for the retention GC and its artifacts are deliberately
not shown.

### `/uploads` replaces the previous grant batch — the anti-drift mechanism

A per-(StepRun, attempt) grant batch is stored in `step_run_upload_grants`,
and a repeated `/uploads` **replaces** it rather than adding to it (spec:
"permintaan ulang mengganti grant sebelumnya, bukan menambah, sehingga kuota
diperiksa atas satu daftar utuh dan tidak pernah hanyut"). `/result` only
records artifacts that are still in the current batch, so a batch superseded
by a re-request can never be recorded. Combined with the quota re-check
against recorded sizes, repeated requests provably cannot drift past the 5 GiB
per-StepRun ceiling.

`kind: "log"` grants are minted one per chunk by the log flush and never
touch the stored batch — otherwise every chunk mint would wipe the turn's
artifact grants.

### Quota is rejected at URL-mint time, and recorded sizes are capped at minted sizes

Each artifact request declares its size (`size_bytes`); 1 GiB per artifact
and 5 GiB per StepRun are rejected at `/uploads`, before a byte is uploaded
(spec: "ditolak saat URL diminta, bukan setelah byte naik"). At `/result`,
the recorded size must not exceed the size declared at mint time, and the
per-artifact and per-StepRun quotas are re-checked against the recorded
numbers — so a Runner that declared small and reported large is refused too.

### The diff is materialized by the Runner, as one more artifact

At the end of a succeeded turn, the Runner computes `git diff <base> <head>`
from its own clone and uploads it as an artifact keyed `diff` — the same
peer-to-peer path as every other artifact (spec: "Diff dimaterialisasi jadi
blob saat StepRun berakhir, sehingga branch bebas dihapus"). The pushed SHA
already lives on `step_runs` (`output_ref_sha`) as the link back to GitHub,
so the branch itself can be deleted without the change being lost. Best-effort
by the same AC5 rule: a failed `git diff` or a failed upload yields no diff
artifact and no failed StepRun.

### All to blob; no inline Postgres

Every artifact is an object in Garage under `artifact/<step_run_id>/<key>`.
There is no inline-Postgres path, no size threshold that splits a small
artifact into a column — a threshold would double every write/read/delete
path and double the places a secret can settle (spec: "Semua ke blob, tanpa
jalur inline Postgres"). The stated exception — `runs.definition` and
`runs.definition_files` inline in Postgres — is not a precedent: that
snapshot is not an Artifact, the execution path reads it, and it must live
exactly as long as the Run row.

### Slug keys; uniqueness never promised

An artifact `key` reported by the Runner is stored under its normalized
lowercase slug (`PRD` → `prd`, `My Report.md` → `my-report.md`). Unlike
fan-out Keys, uniqueness across StepRuns is deliberately not promised — the
"riwayat PRD" is a per-key query across turns, and two turns whose keys
diverge silently break the chain (spec: "keunikan memang tidak pernah
dijanjikan di sini — berbeda dari Key fan-out"). Within one StepRun, the
UNIQUE `(step_run_id, key)` constraint holds structurally, and a batch with
two keys that slug to the same value is refused at mint time.

### Read authorization is Project membership

Reading an artifact — metadata or a presigned GET — requires the StepRun's
Project membership, exactly like the log surface. The org `owner` is NOT
automatically a member (spec: "owner org tidak otomatis dapat akses data
Project; ia harus menambahkan dirinya jadi anggota"). Presigned GETs are
minted only after the authorization check, 5 minutes stated, revocation-is-
not-recall (ADR-0001's rule, unchanged).

## Consequences

- The control plane still never holds an artifact byte: it mints URLs,
  records the metadata the Runner reports, and hands the browser a URL.
- A buggy or lying Runner can still write more bytes to Garage than the
  quota declared; the control plane cannot verify what was actually uploaded
  — accepted, because the Runner is inside the trust boundary (the same
  acceptance as ADR-0001's log cap).
- The grant table is bounded: a batch is deleted when its turn commits
  (`/result` or `/question`), so it never outlives its purpose.
- Artifact retention (90 days after the Run ends) is driven by Postgres state
  (`runs.artifacts_purged_at`), exactly like logs — the sweep in
  `db/sql/retention_sweeps.sql` needs no lifecycle rule on the bucket.
