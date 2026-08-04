# 0001 — Log streaming: chunked objects, live-tail, and the object store

Status: Accepted (implemented by issue #7 — Log: Garage, chunk, dan live-tail)

## Context

A developer wants to watch a StepRun's log live from the browser while it
runs, and read the same log as an archive once it ends, without a single byte
passing through the control plane. The constraint that shapes the whole
design: **object storage cannot be read while it is written**, so a live log
is many objects, not one growing object. Compaction is rejected — the Runner
may die, the control plane must not hold bytes, and multipart requires parts
far larger than our chunks.

## Decisions

### Garage, pinned exact, with its own hostname and bucket CORS

Garage is pinned exactly at `dxflrs/garage:v2.3.0`. The pin is load-bearing:
any pre-2.3.0 version boots clean and reports a healthy node but fails on the
first upload ("Layout not ready"); v2.3.0 is the first release whose
`--single-node --default-bucket --default-access-key` flags remove the manual
layout step (verified hands-on, see `.scratch/distributed-software-factory/
recon-deps.md`). Garage runs behind its own hostname because SigV4 signs the
path and the `Host` header, so it cannot share an origin with web + API.

Bucket CORS is set through the S3 API (`PutBucketCors` — there is no
`garage bucket cors` CLI subcommand): `GET` for the browser origin, `PUT` for
the Runner origin (deploy/garage/configure-cors.sh). The browser reads log
chunks and artifacts straight from Garage; the Runner uploads log chunks and
artifacts straight to Garage.

### The Runner flushes chunks; the control plane records metadata only

The Runner flushes every **1 second or 256 KiB**, whichever comes first. Each
chunk is PUT to Garage via a presigned URL minted by the control plane (which
owns the Garage credentials), and only afterwards is the chunk's metadata
recorded through `POST /step-runs/:id/log-chunks`. The order is the invariant
behind "upload dulu → catat metadata": a `log_chunks` row existing implies its
blob exists. The control plane never counts log bytes; it records the size the
Runner declares.

### Dedup at the primary key, not in code

Chunks are keyed by (StepRun, attempt), and dedup lives in the primary key
`(step_run_id, attempt, seq)` with `ON CONFLICT DO NOTHING` — a resend is a
200 that inserts nothing, never a 409 and never an application-code check.
A dead attempt's chunks are never overwritten by the next attempt: the same
`seq` in a higher `attempt` is a distinct row, and live-tail/archive reads are
scoped to one attempt.

### Live-tail and archive share one endpoint

`GET /step-runs/{id}/log?attempt=N&offset=S` long-polls up to 30 seconds from
`offset` — the same long-poll shape as `/claim`, polled once per second — and
returns any chunks with `seq >= offset` as a list of freshly-minted 5-minute
presigned GETs, never bytes. The browser fetches each chunk from Garage and
appends it in `seq` order. The archive is the same endpoint from offset zero.
One browser tab is one hanging connection; a per-instance cap (mirroring
`/claim`'s) answers 503 + Retry-After above it.

SSE and WebSocket are rejected on their own merits, not on NAT grounds: the
Runner flushes at most every 1 second, so data fresher than the poll cadence
does not exist.

### Ring buffer and cap produce two distinct marker chunks

Two mechanisms that must never be conflated:

- a **ring buffer of 64 MiB** bounds the pending in-memory log while the
  object store is slow or down; past it the **oldest** bytes are dropped
  (failure is at the newest end), and one chunk carrying the ring marker is
  produced;
- a **cap of 256 MiB** bounds the whole log; past it output is truncated
  **without failing the StepRun**, and one chunk carrying the cap marker is
  produced.

On the wire the two are invisible — each is just one chunk whose text is its
marker (`[factory: ring buffer overflow — N bytes of oldest output dropped]`
vs `[factory: log capped at N bytes — further output dropped]`). Tests prove
the two are never conflated.

### Redaction is literal, best-effort, and explicitly not a security control

Agent-captured text is redacted before upload by replacing the **exact**
literal strings the Runner holds (its git tokens today) with a placeholder —
identical scope to Artifact redaction, no wider. There is deliberately no
regex, no entropy detection, no "looks like a key" heuristic: those do not
improve any guarantee, they only make readers believe one exists. This is
documented as **not** a security control. The security boundary is
default-deny egress from the sandbox, branch protection, and the narrow
`repository_ids`/`contents:write` scoping of installation tokens. A secret
that takes a form the literal list does not cover is redacted never — by
design.

### Presigned URLs: 5 minutes, stated; revocation is not recall

Presigned URLs live **5 minutes, stated, not shortened**. Revoking a person's
access applies instantly to everything they ask for *next*; URLs already
minted stay valid until expiry. **Revocation is not recall.** This is stated
in the API surface (`expiresAt` on every grant and chunk) and documented for
operators.

## Consequences

- Byte traffic is peer-to-peer between the browser/Runner and Garage; the
  control plane needs only the S3 credentials to mint URLs, and a reverse
  proxy in front of it never sees log bytes.
- A buggy Runner can exceed the 256 MiB cap and the control plane will not
  know — accepted, because the Runner is already inside the trust boundary.
- Log retention (30 days after a Run ends) is driven by Postgres state, not
  bucket lifecycle rules, exactly like artifacts (see db/sql/
  retention_sweeps.sql).
- The browser must treat `expiresAt` on each chunk as authoritative: a chunk
  fetched after expiry will 403 from Garage and must be re-polled from its
  seq (the same endpoint re-mints fresh URLs).
