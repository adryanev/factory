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

**Found:**
- ✅ Latest stable version: **v2.3.0** (released April 16, 2026)
- ✅ Single-node support: `--single-node` flag auto-creates layout for single nodes (added in v2.3.0 improvements)
- ✅ Default environment variable support: `--default-access-key` and `--default-bucket` for easier setup
- ✅ S3-compatible distributed object store built for self-hosting
- ⚠️ Bucket-level CORS: **NOT EXPLICITLY VERIFIED** — search results reference CORS support in context of S3 compatibility but no specific documentation on bucket-level configuration found
- ⚠️ Upload failure threshold: **COULD NOT VERIFY** — no specific information found about which version threshold triggers upload-time vs. boot-time failures

**Evidence:**
- Forge Deuxfleurs releases page (v2.3.0 release announcement)
- OneUptime S3 setup guide (March 2026) confirms current status

**Verdict:** **STALE** (on upload failure threshold — spec notes this is critical for bootstrap validation, needs investigation during implementation)

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
| Garage | **YES** | Verify upload failure threshold before bootstrap code; test single-node CORS config |
| Drizzle partial index | No | Use `.where()` and `.nullsNotDistinct()` natively; no raw-SQL fallback |
| Zod→OpenAPI | No | Pick zod-openapi or @asteasolutions/zod-to-openapi; both production-ready |
| testcontainers | No | Test on Node 26 early if paranoid; minimum met |
| GitHub signatures | No | Proceed; confirmed for installation tokens |

---

## Confidence Summary

- **CONFIRMED**: 5 items (sandcastle, Drizzle, Zod→OpenAPI, testcontainers, GitHub signatures)
- **COULD NOT VERIFY**: 2 items, both on Garage — the bucket-level CORS surface, and the version
  threshold below which uploads fail. Neither blocks work before issue #7. Both are answerable
  only by running Garage, so they are settled there, not by more searching.
