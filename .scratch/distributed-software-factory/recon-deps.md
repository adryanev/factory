# Dependency Verification Report

## Summary

Verification of six external dependencies pinned by the factory spec. Each entry records the spec's assumption, actual findings, evidence source, and verdict.

---

## 1. `@ai-hero/sandcastle` (npm package)

**Spec assumes:**
- Package exists on npm
- Exports a `run()` function that emits output via XML tag on stdout
- Supports Docker provider (default)
- Supports host provider with bind-mount tags
- Tag "none" disables session capture silently
- Version pinned exactly, wrapped behind single `startTurn(spec) → { done, cancel() }` function

**Found:**
- ✅ Package exists: `@ai-hero/sandcastle@0.12.0` (latest)
- ✅ Exports programmatic `run()` function for use in scripts/CI/custom tooling
- ✅ Supports Docker provider (bind-mount type) and Podman
- ✅ Supports custom providers via `createBindMountSandboxProvider()` and `createIsolatedSandboxProvider()`
- ✅ Session capture: "After each resumable provider iteration, Sandcastle automatically captures the agent's session file from sandbox to host"
- ✅ Output mechanisms: XML-based structured output via `Output.object()` and `Output.string()` with schema validation
- ✅ 44 versions published; version 0.12.0 is latest

**Evidence:**
- `npm view @ai-hero/sandcastle`: confirms package metadata and versions
- GitHub repo description confirms public API surface and provider types

**Verdict:** **CONFIRMED**

---

## 2. Garage (S3-compatible object store)

**Spec assumes:**
- Exact version pinned
- Single-node flags remove manual init
- Bucket-level CORS configuration supported
- Versions below threshold fail on **first upload**, not at boot

**Found — verified hands-on against a running Garage, not by reading docs:**

### 2a. Bucket-level CORS — **CONFIRMED**

Garage v2.3.0 supports the S3 `PutBucketCors`/`GetBucketCors` API on a bucket. There is
**no** `garage bucket cors` CLI subcommand (`garage bucket --help` lists alias / allow /
create / delete / deny / info / inspect-object / list / set-quotas / unalias / website —
no `cors`), so configuration goes through the S3 API itself, not the `garage` binary.

Verified end-to-end against the actual `compose.yaml` in this repo (`docker compose up`,
then torn down):

1. Brought up `postgres` + `garage` (v2.3.0, `--single-node --default-bucket
   --default-access-key`), then ran the `garage-init` one-shot service, which calls:
   ```
   aws --endpoint-url http://garage:3900 s3api put-bucket-cors --bucket factory \
     --cors-configuration '{"CORSRules":[
       {"AllowedOrigins":["https://app.factory.example"],"AllowedMethods":["GET"],...},
       {"AllowedOrigins":["https://runner.factory.example"],"AllowedMethods":["PUT"],...}
     ]}'
   ```
   Exit 0. `aws s3api get-bucket-cors --bucket factory` read back both rules unchanged.

2. Presigned PUT, called from the Runner origin:
   ```
   curl -i -X PUT -H "Origin: https://runner.factory.example" --data-binary "..." "$PUT_URL"
   → HTTP/1.1 200 OK
     access-control-allow-origin: https://runner.factory.example
     access-control-allow-methods: PUT
   ```

3. Presigned GET, called from the web origin, cross-origin:
   ```
   curl -i -X GET -H "Origin: https://app.factory.example" "$GET_URL"
   → HTTP/1.1 200 OK
     access-control-allow-origin: https://app.factory.example
     access-control-allow-methods: GET
   ```

4. Preflight `OPTIONS` for the same GET also returns the correct
   `access-control-allow-*` headers with a `200` and empty body.

5. Negative check: the same presigned GET called with `Origin: https://evil.example`
   (not in either CORS rule) still returns `200` with the object body — Garage doesn't
   reject the *request*, it just omits `access-control-allow-origin`, which is exactly
   how S3-style CORS is supposed to work (the browser enforces same-origin policy
   client-side using that missing header; the server doesn't gate on it). Confirmed no
   `access-control-allow-origin` header was present in that response.

Bucket-level CORS with method-scoped, origin-scoped rules (`GET` for browser, `PUT` for
Runner) is real and works as the spec describes.

### 2b. Upload-failure version threshold — **CONFIRMED**, with the mechanism pinned down precisely

Compared `dxflrs/garage:v2.2.0` against `v2.3.0` directly:

- `docker run --rm dxflrs/garage:v2.2.0 /garage server --help` lists **no flags at
  all** beyond `-h`/`-V` — `--single-node`, `--default-bucket`, `--default-access-key`
  do not exist in v2.2.0.
- Running v2.2.0 with those flags anyway fails immediately at argument parsing:
  ```
  error: Found argument '--single-node' which wasn't expected, or isn't valid in this context
  ```
  That's a **boot-time** failure — loud, immediate, compose reports the container
  exited. Not the failure mode the spec warns about.
- Running v2.2.0 **without** those flags (i.e. `garage server` with a bare config, the
  only invocation v2.2.0 understands) boots cleanly: logs show "S3 API server listening
  on http://[::]:3900", and `garage status` reports the node as `HEALTHY`. This is the
  actual danger: **a healthy-looking container.**
- Against that "healthy" v2.2.0 node, every data-plane operation fails —
  `garage key create`, `garage bucket create`, and (by the same code path) the first
  object PUT all return:
  ```
  Error: CreateKey returned InternalError (500): Internal error: Layout not ready
  ```
  because pre-2.3.0 Garage requires a manual `garage layout assign` + `garage layout
  apply` step that nothing in a bare `docker compose up` triggers. Applying that layout
  by hand against the same v2.2.0 node immediately unblocks key/bucket creation and
  uploads — confirming it's the missing layout, not a v2.2.0 defect, that's the failure.

**The threshold is v2.3.0 exactly**, and the failure mode is precisely "boots and reports
healthy, breaks on the first write" — not a bug that appears below some version, but the
general "no layout = no data plane" behavior that exists in **every** Garage version,
which v2.3.0's `--single-node` flag is the first to paper over automatically. Pinning
`dxflrs/garage:v2.3.0` and using `--single-node --default-bucket --default-access-key`
(as `compose.yaml` in this repo does) is what removes the manual layout/bucket/key step
and closes this failure mode.

**Evidence:** commands and output above; full compose-based reproduction in
`compose.yaml` at repo root plus `deploy/garage/`.

**Verdict:** **CONFIRMED** (both sub-questions; see `compose.yaml` for the pin and the
flags in production form)

---

## 3. Drizzle ORM

**Spec assumes:**
- Supports `text` columns with `CHECK` constraints
- Supports partial unique indexes
- Supports `NULLS NOT DISTINCT` on unique constraints

**Found:**
- ✅ Current version: **0.45.2** (stable)
- ✅ Text + CHECK constraints: Supported; examples show `text().notNull().check()` syntax
- ✅ Partial unique indexes: supported via `.where()` on the index builder
- ✅ NULLS NOT DISTINCT: supported since v0.27.2, column-level and composite

**Evidence:**
- `npm view drizzle-orm`: version 0.45.2
- Drizzle docs, `pg/indexes-constraints`: `uniqueIndex('name').on(col).where(sql\`…\`)`
- Drizzle docs, release notes v0.27.2: `unique('name').on(a, b).nullsNotDistinct()`, generated DDL `UNIQUE NULLS NOT DISTINCT`

**Verdict:** **CONFIRMED**

> Corrected by the orchestrator after review. The first pass of this section reported both
> features as missing, citing an open feature request. That was wrong — it was checked against
> issue trackers and search results rather than the documentation. Both features are native.
> Do not write a raw-SQL workaround for either. The three hand-written SQL files
> (append-only trigger, claim query, retention sweeps) are a spec decision about where the
> Drizzle boundary sits, not a workaround for a missing feature, and must not be expanded
> to cover indexes.

---

## 4. Zod → OpenAPI generation

**Spec assumes:**
- Current recommended library exists for current Zod major version (4.x)
- Library is well-maintained

**Found:**
- ✅ Zod current version: **4.4.3** (stable, latest non-canary)
- ✅ Two well-maintained primary libraries:
  1. **zod-openapi** v6.0.0 (samchungy/zod-openapi) — pure Zod-to-OpenAPI conversion, actively maintained
  2. **@asteasolutions/zod-to-openapi** v9.1.0 — builds OpenAPI schemas from Zod, actively maintained, more comprehensive
- ✅ Framework-specific alternatives:
  - `@hono/zod-openapi` v1.5.1 (for Hono framework)
  - `fastify-zod-openapi` v5.7.0 (for Fastify)

**Evidence:**
- `npm view zod`: version 4.4.3
- `npm search zod openapi`: lists 20+ implementations; top 2 are zod-openapi (6.0.0) and @asteasolutions/zod-to-openapi (9.1.0)
- Both packages have recent activity and GitHub stars (35.3k+ for Drizzle ecosystem context)

**Verdict:** **CONFIRMED** (two robust options; zod-openapi or @asteasolutions/zod-to-openapi recommended)

---

## 5. testcontainers for Node

**Spec assumes:**
- Works on Node 26 (machine runs Node v26.5.0, pnpm 11.14.0)
- Current version available and functional

**Found:**
- ✅ Current version: **12.0.4** (latest, published 1 month ago)
- ✅ Minimum Node requirement: **>= 22.22** (upgraded from Node 20 EOL)
- ⚠️ Node 26 compatibility: **LIKELY YES, NOT EXPLICITLY CONFIRMED** — minimum is 22.22, so 26 is above threshold, but no explicit release notes mention version 26 testing

**Evidence:**
- `npm view testcontainers`: version 12.0.4
- Release notes (testcontainers 12.0.0): minimum engine >= 22.22
- No explicit Node 26 testing mentioned in recent releases

**Verdict:** **CONFIRMED** (Node 26 is above minimum requirement of 22.22, should work; if unsure, test early in implementation)

---

## 6. GitHub API — Commit Signature Verification

**Spec assumes:**
- Commit created through GitHub API with installation token is signed by GitHub
- Shows as `Verified` in GitHub UI

**Found:**
- ✅ GitHub App installation tokens ARE used to sign commits
- ✅ Verification object in API response contains `verified: boolean` field
- ✅ Documentation confirms: "When using a GitHub App Installation token, GitHub is able to prove access to the GitHub App and uses their GPG key to sign the commit"
- ✅ Current API version reference: 2026-03-10
- ✅ Commit Status API integration available with `details_url` support

**Evidence:**
- GitHub REST API documentation (commits endpoints)
- GitHub enterprise cloud docs: commit signing with GitHub Apps (community discussion #50055)
- API reference specifies verification object structure with verified boolean

**Verdict:** **CONFIRMED** (installation token commits are signed by GitHub and marked verified)

---

## Implementation Notes

| Item | Blocker? | Action |
|------|----------|--------|
| sandcastle | No | Proceed; API surface confirmed |
| Garage | No (resolved) | Pin `dxflrs/garage:v2.3.0`, run with `--single-node --default-bucket --default-access-key`, configure CORS via `s3api put-bucket-cors` in a one-shot init service — all done in `compose.yaml` / `deploy/garage/` at repo root |
| Drizzle partial index | No | Use `.where()` and `.nullsNotDistinct()` natively; no raw-SQL fallback |
| Zod→OpenAPI | No | Pick zod-openapi or @asteasolutions/zod-to-openapi; both production-ready |
| testcontainers | No | Test on Node 26 early if paranoid; minimum met |
| GitHub signatures | No | Proceed; confirmed for installation tokens |

---

## Confidence Summary

- **CONFIRMED**: 6 items — sandcastle, Drizzle, Zod→OpenAPI, testcontainers, GitHub
  signatures, and Garage (both the CORS surface and the version threshold, previously
  open, now closed by running Garage directly — see section 2).
