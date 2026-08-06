/**
 * Issue #18 — Automation, over the seam-1 rig: the GitHub App webhook
 * (`/webhook/github`, HMAC), the sweep (deliveries → triggers, queue drain,
 * schedule), and the Project-level kill switch, against a real Postgres and
 * the real HTTP server. The fake git host stands in for GitHub; the fixed
 * rig clock stands in for time (cron expressions are evaluated against it).
 *
 * The acceptance criteria, mapped to the tests below:
 *  - `on:` maps two sets — Pipelines hosted by the pushed repo are read from
 *    the pushed ref; cross-repo Pipelines in a config repo are read from the
 *    config repo's default branch (tests 2-3);
 *  - the definition cache is mandatory but disposable — a miss is refilled
 *    synchronously by the next event (test 4);
 *  - fork PRs are ignored entirely (test 5);
 *  - two-layer dedup: delivery id for 24h, then the natural key (Pipeline,
 *    SHA); a redelivery never cancels the Run it duplicates (tests 6-7);
 *  - the natural key is a partial unique index scoped to automation and not
 *    rewind — manual triggers and rewind still run over the same commit
 *    (test 8);
 *  - default concurrency `cancel` (test 9); `queue` drains depth-1 (test 10);
 *  - cron skips on overlap, visibly, and a schedule lives only on the
 *    default branch — after merge (test 11);
 *  - branch deleted / PR closed cancels, including `awaiting-human` (tests
 *    12-13);
 *  - `automation_enabled` is admin-only and audited (test 14);
 *  - comment triggers do not exist (test 15).
 */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateId } from "@factory/shared";
import { sweepExpiredLeases } from "../../src/domain/step-run-ops.js";
import { sweepWebhookDeliveries, WEBHOOK_MAX_ATTEMPTS, webhookRetryBackoffMs } from "../../src/domain/automation.js";
import { runRetentionSweeps } from "../../src/domain/retention-sweeps.js";
import type { GitHost } from "../../src/domain/git-host.js";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner } from "./runner-test-helpers.js";

const WEBHOOK_SECRET = "test-webhook-secret"; // setup.ts's rig value.
const PIPELINE_PATH = ".factory/pipeline.yaml";

let repoCounter = 1000;

async function createProject(rig: TestRig, cookie: string, name: string): Promise<{ id: string }> {
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  const project = (await response.json()) as { id: string };
  await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
    method: "POST",
    headers: { cookie },
  });
  return project;
}

async function createRepository(
  rig: TestRig,
  projectId: string,
  name: string,
): Promise<{ id: string; owner: string; name: string }> {
  repoCounter += 1;
  const owner = `auto-owner-${repoCounter}`;
  const installationRowId = generateId("installation");
  await rig.pool.query(
    "insert into github_app_installations (id, project_id, installation_id, account_login) values ($1, $2, $3, $4)",
    [installationRowId, projectId, 20_000_000 + repoCounter, owner],
  );
  const repositoryId = generateId("repository");
  await rig.pool.query(
    "insert into repositories (id, project_id, github_app_installation_id, owner, name, default_branch) values ($1, $2, $3, $4, $5, 'main')",
    [repositoryId, projectId, installationRowId, owner, name],
  );
  return { id: repositoryId, owner, name };
}

/** Automation runs as the Project's ServiceAccount — create the principal and its account row. */
async function createServiceAccount(rig: TestRig, projectId: string): Promise<string> {
  const principalId = generateId("serviceaccount");
  await rig.pool.query("insert into principals (id, kind) values ($1, 'service_account')", [principalId]);
  await rig.pool.query(
    "insert into service_accounts (principal_id, project_id, name) values ($1, $2, 'automation')",
    [principalId, projectId],
  );
  return principalId;
}

interface Repo {
  id: string;
  owner: string;
  name: string;
}

function repoRef(repo: Repo): { owner: string; name: string } {
  return { owner: repo.owner, name: repo.name };
}

/** Registers `ref` → `sha` and the Pipeline file at that sha. */
function registerPipeline(
  rig: TestRig,
  repo: Repo,
  ref: string,
  sha: string,
  content: string,
): void {
  rig.gitHost.registerRef(repoRef(repo), ref, sha);
  rig.gitHost.registerFile(repoRef(repo), sha, PIPELINE_PATH, content);
}

/** Registers an arbitrary file at a sha (a prompt file, or a second Pipeline path). */
function registerFileAt(
  rig: TestRig,
  repo: Repo,
  sha: string,
  path: string,
  content: string,
): void {
  rig.gitHost.registerFile(repoRef(repo), sha, path, content);
}

function pipelineYaml(repoName: string, body: string): string {
  return `version: 1\nname: automation\nrepo: ${repoName}\n${body}`;
}

function pushPayload(
  repo: Repo,
  branch: string,
  sha: string,
  changedPaths: string[] = [PIPELINE_PATH],
): unknown {
  return {
    ref: `refs/heads/${branch}`,
    after: sha,
    deleted: false,
    commits: [{ modified: changedPaths }],
    repository: { full_name: `${repo.owner}/${repo.name}` },
  };
}

async function webhook(
  rig: TestRig,
  eventType: string,
  deliveryId: string,
  payload: unknown,
  secret: string = WEBHOOK_SECRET,
): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")}`;
  return fetch(`${rig.baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

/** Drives the whole processing pipeline: the webhook lands the event, the executor cycle's sweep maps it. */
async function webhookAndSweep(
  rig: TestRig,
  eventType: string,
  deliveryId: string,
  payload: unknown,
): Promise<Response> {
  const response = await webhook(rig, eventType, deliveryId, payload);
  await sweepExpiredLeases(rig.deps);
  return response;
}

/** The same cadence — the automation sweep rides every executor cycle (production shape). */
async function sweep(rig: TestRig): Promise<void> {
  await sweepExpiredLeases(rig.deps);
}

async function runsOf(
  rig: TestRig,
  projectId: string,
): Promise<{ id: string; trigger_kind: string; ref_branch: string; ref_sha: string; cancel_requested_at: Date | null; outcome: string | null; ended_at: Date | null }[]> {
  const { rows } = await rig.pool.query(
    `select id, trigger_kind, ref_branch, ref_sha, cancel_requested_at, outcome, ended_at
       from runs where project_id = $1 order by ref_sha`,
    [projectId],
  );
  return rows;
}

async function stepOutcomeOf(
  rig: TestRig,
  runId: string,
  stepKey: string,
): Promise<{ outcome: string; reason: string | null }[]> {
  const { rows } = await rig.pool.query(
    "select outcome, reason from step_runs where run_id = $1 and step_key = $2",
    [runId, stepKey],
  );
  return rows;
}

interface WebhookDeliveryRow {
  processed_at: Date | null;
  attempts: number;
  next_attempt_at: Date;
}

async function deliveryRow(rig: TestRig, deliveryId: string): Promise<WebhookDeliveryRow> {
  const { rows } = await rig.pool.query<WebhookDeliveryRow>(
    "select processed_at, attempts, next_attempt_at from webhook_deliveries where delivery_id = $1",
    [deliveryId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no webhook_deliveries row for ${deliveryId}`);
  return row;
}

/**
 * Wraps a real `GitHost` so `readFile` throws `failTimes` times before
 * falling through to `base` — the deterministic stand-in for a transient
 * GitHub read failure (the real cause `sweepWebhookDeliveries`'s retry
 * exists for). Every other call passes straight through, unmodified — no
 * spread, so the fake's own test-inspection fields (`minted`, `pushed`, ...)
 * never leak into what is typed as a plain `GitHost`.
 */
function withFailingReadFile(base: GitHost, failTimes: number): GitHost {
  let remaining = failTimes;
  return {
    resolveRef: (repo, ref) => base.resolveRef(repo, ref),
    readFile: async (repo, sha, path) => {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("fake github read failed: 503");
      }
      return base.readFile(repo, sha, path);
    },
    mintInstallationToken: (repo, installationId, permissions) =>
      base.mintInstallationToken(repo, installationId, permissions),
    push: (repo, branch, sha, token) => base.push(repo, branch, sha, token),
    findOpenPullRequest: (repo, head, baseRef, token) => base.findOpenPullRequest(repo, head, baseRef, token),
    createPullRequest: (repo, input, token) => base.createPullRequest(repo, input, token),
    postCommitStatus: (repo, sha, status, token) => base.postCommitStatus(repo, sha, status, token),
    writeFile: (repo, input, token) => base.writeFile(repo, input, token),
    revokeInstallationToken: (token) => base.revokeInstallationToken(token),
    listRefsByPrefix: (repo, prefix, token) => base.listRefsByPrefix(repo, prefix, token),
    deleteRef: (repo, branch, token) => base.deleteRef(repo, branch, token),
  };
}

describe("Automation (issue #18)", () => {
  let rig: TestRig;
  let ownerCookie: string;
  let ownerPrincipalId: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
    const { rows } = await rig.pool.query(
      "select principal_id from users where password_hash is not null limit 1",
    );
    ownerPrincipalId = (rows[0] as { principal_id: string }).principal_id;
  });

  beforeEach(() => {
    rig.gitHost.reset();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("webhook contract: HMAC gates the endpoint (401 on a wrong secret, 400 without a delivery id)", async () => {
    const project = await createProject(rig, ownerCookie, "webhook-contract");
    const repo = await createRepository(rig, project.id, "app");

    const bad = await webhook(
      rig,
      "push",
      "delivery-wrong-secret",
      pushPayload(repo, "main", "sha-x"),
      "wrong-secret",
    );
    expect(bad.status).toBe(401);

    const noDelivery = await fetch(`${rig.baseUrl}/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify(pushPayload(repo, "main", "sha-x")),
    });
    expect(noDelivery.status).toBe(400);

    // A signed, well-formed delivery is accepted without touching GitHub.
    const ok = await webhook(rig, "push", "delivery-contract-ok", pushPayload(repo, "main", "sha-x"));
    expect(ok.status).toBe(202);
  });

  it("on: push — the hosted set reads the definition from the pushed ref, and a non-matching branch is ignored", async () => {
    const project = await createProject(rig, ownerCookie, "hosted-push");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("app", "on:\n  push:\n    branches: [main]\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-hosted-main", yaml);
    registerPipeline(rig, repo, "feature", "sha-hosted-feature", yaml);

    const response = await webhookAndSweep(
      rig,
      "push",
      "delivery-hosted-main",
      pushPayload(repo, "main", "sha-hosted-main"),
    );
    expect(response.status).toBe(202);

    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger_kind).toBe("automation");
    expect(runs[0]!.ref_branch).toBe("main");
    expect(runs[0]!.ref_sha).toBe("sha-hosted-main");
    expect((await stepOutcomeOf(rig, runs[0]!.id, "build"))[0]!.outcome).toBe("ready");

    // A push to `feature` carries the same definition but fails the branches filter.
    await webhookAndSweep(
      rig,
      "push",
      "delivery-hosted-feature",
      pushPayload(repo, "feature", "sha-hosted-feature"),
    );
    expect(await runsOf(rig, project.id)).toHaveLength(1);
  });

  it("on: push — a Pipeline is hosted by its own repo, and the same push keeps the cache fresh", async () => {
    // The hosted set: any push to the host repo matching the branches/paths
    // filters fires its Pipeline (read from the pushed ref). This is also the
    // mechanism that refills the definition cache for that repo.
    const project = await createProject(rig, ownerCookie, "hosted-own-repo");
    const repo = await createRepository(rig, project.id, "config");
    await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("config", "on:\n  push:\n    branches: [main]\nsteps:\n  deploy:\n    run: echo deploy\n");
    registerPipeline(rig, repo, "main", "sha-hosted-own", yaml);

    await webhookAndSweep(rig, "push", "delivery-hosted-own", pushPayload(repo, "main", "sha-hosted-own"));
    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ref_sha).toBe("sha-hosted-own");
    const { rows } = await rig.pool.query(
      "select count(*)::int as n from pipeline_definition_cache where repository_id = $1",
      [repo.id],
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("on: push — the cross-repo set reads its definition from the config repo's default branch", async () => {
    const project = await createProject(rig, ownerCookie, "cross-repo");
    const app = await createRepository(rig, project.id, "app");
    const config = await createRepository(rig, project.id, "config");
    await createServiceAccount(rig, project.id);

    // The config repo hosts a Pipeline that triggers on pushes to `app`.
    // Its definition is read from config's *default branch* (the push ref
    // does not exist there).
    const configYaml = pipelineYaml(
      "config",
      "on:\n  push:\n    repos: [app]\n    branches: [main]\nsteps:\n  deploy:\n    run: echo deploy\n",
    );
    registerPipeline(rig, config, "main", "sha-cfg-main", configYaml);

    // A push to the config repo itself fills the cache (and, being a push to
    // the host repo on a matching branch, hosts its own Run — the `repos:`
    // filter only gates the cross-repo read).
    await webhookAndSweep(rig, "push", "delivery-config-fill", pushPayload(config, "main", "sha-cfg-main"));
    expect(await runsOf(rig, project.id)).toHaveLength(1);

    // A push to `app` triggers the config-hosted Pipeline over the pushed ref.
    const appSha = "sha-app-1";
    await webhookAndSweep(rig, "push", "delivery-app-1", pushPayload(app, "main", appSha));

    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(2);
    const cross = runs.find((run) => run.ref_sha === appSha)!;
    expect(cross.trigger_kind).toBe("automation");
    expect(cross.ref_branch).toBe("main");
    const { rows } = await rig.pool.query(
      "select pipeline_repository_id from runs where project_id = $1 and ref_sha = $2",
      [project.id, appSha],
    );
    expect((rows[0] as { pipeline_repository_id: string }).pipeline_repository_id).toBe(config.id);
  });

  it("the definition cache is mandatory but disposable: a miss is refilled synchronously by the next event", async () => {
    const project = await createProject(rig, ownerCookie, "cache-miss");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("app", "on:\n  push:\n    branches: [main]\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-cache-a", yaml);

    await webhookAndSweep(rig, "push", "delivery-cache-1", pushPayload(repo, "main", "sha-cache-a"));
    expect(await runsOf(rig, project.id)).toHaveLength(1);

    // Evict the whole cache — the "boleh dihapus kapan saja" claim.
    await rig.pool.query("delete from pipeline_definition_cache");

    // The next event rebuilds it before it can be discovered, synchronously.
    registerPipeline(rig, repo, "main", "sha-cache-b", yaml);
    await webhookAndSweep(rig, "push", "delivery-cache-2", pushPayload(repo, "main", "sha-cache-b"));
    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.ref_sha).toBe("sha-cache-b");
    const { rows } = await rig.pool.query("select count(*)::int as n from pipeline_definition_cache");
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("fork PRs are ignored entirely; a same-repo PR triggers from the head ref and SHA", async () => {
    const project = await createProject(rig, ownerCookie, "fork-pr");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const prYaml = pipelineYaml("app", "on:\n  pullRequest: true\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-pr-cache", prYaml);
    registerFileAt(rig, repo, "sha-pr-head", PIPELINE_PATH, prYaml);

    // The cache is the discovery index — fed by pushes. A push carrying the
    // PR pipeline fills it without triggering anything (no on: push).
    await webhookAndSweep(rig, "push", "delivery-pr-fill", pushPayload(repo, "main", "sha-pr-cache"));

    const fullName = `${repo.owner}/${repo.name}`;
    const prPayload = (headRepo: string) => ({
      action: "opened",
      repository: { full_name: fullName },
      pull_request: {
        head: { ref: "feature", sha: "sha-pr-head", repo: { full_name: headRepo } },
        base: { repo: { full_name: fullName } },
      },
    });

    // The fork's head is text anyone can write — ignored, no Run at all.
    await webhookAndSweep(rig, "pull_request", "delivery-fork-pr", prPayload("fork-owner/app"));
    expect(await runsOf(rig, project.id)).toHaveLength(0);

    // A PR from the same repo: the definition is read from the head SHA.
    await webhookAndSweep(rig, "pull_request", "delivery-same-repo-pr", prPayload(fullName));
    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ref_branch).toBe("feature");
    expect(runs[0]!.ref_sha).toBe("sha-pr-head");
  });

  it("two-layer dedup: the delivery id is a 24h layer-1 key, and a redelivery never cancels the Run it duplicates", async () => {
    const project = await createProject(rig, ownerCookie, "dedup");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("app", "on:\n  push:\n    branches: [main]\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-dedup", yaml);

    await webhookAndSweep(rig, "push", "delivery-dedup-1", pushPayload(repo, "main", "sha-dedup"));
    expect(await runsOf(rig, project.id)).toHaveLength(1);

    // Same delivery id, redelivered by GitHub: ack'ed, dropped, no second Run.
    await webhookAndSweep(rig, "push", "delivery-dedup-1", pushPayload(repo, "main", "sha-dedup"));
    expect(await runsOf(rig, project.id)).toHaveLength(1);

    // A *new* delivery over the same (Pipeline, SHA): layer-2 dedup — and it
    // must not cancel the Run it would have been a duplicate of.
    await webhookAndSweep(rig, "push", "delivery-dedup-2", pushPayload(repo, "main", "sha-dedup"));
    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cancel_requested_at).toBeNull();
  });

  it("a delivery older than 24h is not deleted by the automation sweep — the retention marker sweep owns that window instead", async () => {
    const project = await createProject(rig, ownerCookie, "dedup-window");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);

    // received_at (and next_attempt_at, so it's immediately due) 25h before
    // the rig's fixed clock — past the old hard-delete's window, and also
    // in the past relative to the real Postgres now() the retention SQL
    // compares against.
    await rig.pool.query(
      "insert into webhook_deliveries (delivery_id, received_at, next_attempt_at, event_type, payload) values ($1, '2025-12-30T23:00:00Z', '2025-12-30T23:00:00Z', 'push', $2)",
      ["delivery-stale", JSON.stringify(pushPayload(repo, "main", "sha-stale"))],
    );
    await sweep(rig);

    // Dispatched (no Pipeline registered, so it's a no-op success) — but the
    // row itself is still there. This sweep never deletes.
    const afterAutomationSweep = await deliveryRow(rig, "delivery-stale");
    expect(afterAutomationSweep.processed_at).not.toBeNull();
    expect(await runsOf(rig, project.id)).toHaveLength(0);

    const counts = await runRetentionSweeps(
      { db: rig.deps.db, pool: rig.pool, objectStore: rig.objectStore, gitHost: rig.gitHost },
      { batch: 100 },
    );
    expect(counts.webhookDeliveries).toBe(1);

    const { rows } = await rig.pool.query<{ n: number; purged_at: Date | null }>(
      "select count(*)::int as n, max(purged_at) as purged_at from webhook_deliveries where delivery_id = 'delivery-stale'",
    );
    expect(rows[0]!.n).toBe(1); // still exists — the marker sweep marks, it does not delete.
    expect(rows[0]!.purged_at).not.toBeNull();
  });

  it("a delivery whose dispatch throws is not marked processed, and is retried on a later sweep", async () => {
    const project = await createProject(rig, ownerCookie, "webhook-retry");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);

    const response = await webhook(rig, "push", "delivery-retry-1", pushPayload(repo, "main", "sha-retry-1"));
    expect(response.status).toBe(202);

    const t0 = new Date("2026-02-01T00:00:00.000Z");
    const failingDeps = { db: rig.deps.db, clock: { now: () => t0 }, gitHost: withFailingReadFile(rig.gitHost, 1) };
    const firstProcessed = await sweepWebhookDeliveries(failingDeps);
    expect(firstProcessed).toBe(1); // one row visited, even though its dispatch failed.

    const afterFailure = await deliveryRow(rig, "delivery-retry-1");
    expect(afterFailure.processed_at).toBeNull(); // not dropped — still eligible for a later sweep.
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.next_attempt_at.getTime()).toBe(t0.getTime() + webhookRetryBackoffMs(1));

    // A later sweep, past the backoff, with the transient failure gone.
    const t1 = new Date(t0.getTime() + webhookRetryBackoffMs(1) + 1);
    const succeedingDeps = { db: rig.deps.db, clock: { now: () => t1 }, gitHost: rig.gitHost };
    const secondProcessed = await sweepWebhookDeliveries(succeedingDeps);
    expect(secondProcessed).toBe(1);

    const afterRetry = await deliveryRow(rig, "delivery-retry-1");
    expect(afterRetry.processed_at?.getTime()).toBe(t1.getTime());
    expect(afterRetry.attempts).toBe(1); // a success does not touch the attempt counter.
  });

  it("a retry does not happen before next_attempt_at — a sweep running too early skips it", async () => {
    const project = await createProject(rig, ownerCookie, "webhook-retry-early");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    await webhook(rig, "push", "delivery-retry-early", pushPayload(repo, "main", "sha-retry-early"));

    const t0 = new Date("2026-02-02T00:00:00.000Z");
    await sweepWebhookDeliveries({ db: rig.deps.db, clock: { now: () => t0 }, gitHost: withFailingReadFile(rig.gitHost, 1) });
    const afterFailure = await deliveryRow(rig, "delivery-retry-early");
    expect(afterFailure.attempts).toBe(1);

    // Still inside the 30s backoff window — even with a healthy gitHost,
    // nothing is due, so nothing is selected.
    const tooEarly = new Date(t0.getTime() + webhookRetryBackoffMs(1) - 1);
    const processed = await sweepWebhookDeliveries({ db: rig.deps.db, clock: { now: () => tooEarly }, gitHost: rig.gitHost });
    expect(processed).toBe(0);

    const stillPending = await deliveryRow(rig, "delivery-retry-early");
    expect(stillPending.processed_at).toBeNull();
    expect(stillPending.attempts).toBe(1);

    // Consume the row so it does not linger as a leftover "due" row for
    // later tests sharing this rig's database.
    const due = new Date(tooEarly.getTime() + 1);
    await sweepWebhookDeliveries({ db: rig.deps.db, clock: { now: () => due }, gitHost: rig.gitHost });
    expect((await deliveryRow(rig, "delivery-retry-early")).processed_at).not.toBeNull();
  });

  it(`a delivery dead-letters after ${WEBHOOK_MAX_ATTEMPTS} failed attempts — marked processed, and logged distinctly from an ordinary retry`, async () => {
    const project = await createProject(rig, ownerCookie, "webhook-dead-letter");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    await webhook(rig, "push", "delivery-dead-letter", pushPayload(repo, "main", "sha-dead-letter"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = new Date("2026-02-03T00:00:00.000Z");
    const alwaysFailingGitHost = withFailingReadFile(rig.gitHost, WEBHOOK_MAX_ATTEMPTS);

    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const processed = await sweepWebhookDeliveries({ db: rig.deps.db, clock: { now: () => now }, gitHost: alwaysFailingGitHost });
      expect(processed).toBe(1);
      now = new Date(now.getTime() + webhookRetryBackoffMs(attempt) + 1);
    }

    const deadLettered = await deliveryRow(rig, "delivery-dead-letter");
    expect(deadLettered.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(deadLettered.processed_at).not.toBeNull(); // marked processed — dead-lettered, not succeeded.

    const dropLog = errorSpy.mock.calls.find((call) => String(call[0]).includes("dead-lettered"));
    expect(dropLog).toBeDefined();

    // Stops being selected — a healthy sweep afterward finds nothing.
    const afterDeadLetter = await sweepWebhookDeliveries({ db: rig.deps.db, clock: { now: () => now }, gitHost: rig.gitHost });
    expect(afterDeadLetter).toBe(0);

    errorSpy.mockRestore();
  });

  it(
    "a permanently-failing delivery does not hang the sweep — the regression that matters most",
    async () => {
      const project = await createProject(rig, ownerCookie, "webhook-no-hang");
      const repo = await createRepository(rig, project.id, "app");
      await createServiceAccount(rig, project.id);
      await webhook(rig, "push", "delivery-no-hang", pushPayload(repo, "main", "sha-no-hang"));

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const now = new Date("2026-02-04T00:00:00.000Z");
      // Fails every single call, forever — if the sweep's loop can re-select
      // an unprocessed row whose schedule never moves, this call never
      // resolves and the test fails by hitting its own timeout below rather
      // than hanging the whole suite.
      const alwaysFailingGitHost = withFailingReadFile(rig.gitHost, Number.MAX_SAFE_INTEGER);
      const processed = await sweepWebhookDeliveries({
        db: rig.deps.db,
        clock: { now: () => now },
        gitHost: alwaysFailingGitHost,
      });
      expect(processed).toBe(1); // the one row, visited exactly once this sweep.

      const row = await deliveryRow(rig, "delivery-no-hang");
      expect(row.processed_at).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at.getTime()).toBeGreaterThan(now.getTime());

      errorSpy.mockRestore();
    },
    5000,
  );

  it("the natural key is a partial unique index: manual triggers and rewind run over the same (Pipeline, SHA)", async () => {
    const project = await createProject(rig, ownerCookie, "partial-index");
    const repo = await createRepository(rig, project.id, "app");
    const serviceAccountPrincipalId = await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("app", "on:\n  push:\n    branches: [main]\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-same-commit", yaml);

    // An automation Run owns the (repo, path, SHA) key.
    await webhookAndSweep(rig, "push", "delivery-pkey-1", pushPayload(repo, "main", "sha-same-commit"));
    const automationRuns = await runsOf(rig, project.id);
    expect(automationRuns).toHaveLength(1);
    const automationRunId = automationRuns[0]!.id;

    // Manual trigger over the same commit — the web button must keep working.
    const manualRunId = generateId("run");
    const manual = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        id: manualRunId,
        repositoryId: repo.id,
        pipelinePath: PIPELINE_PATH,
        refBranch: "main",
      }),
    });
    expect(manual.status).toBe(201);

    // Rewind over the same commit — a child Run of the automation Run, same
    // natural key, must be admitted (the partial index excludes it).
    const rewindRunId = generateId("run");
    await rig.pool.query(
      `insert into runs (id, project_id, pipeline_repository_id, pipeline_path, trigger_kind,
         triggered_by_principal_id, credential_principal_id, ref_branch, ref_sha, parent_run_id,
         definition, definition_files)
       values ($1, $2, $3, $4, 'automation', $5, $5, 'main', $6, $7, '{}'::jsonb, '{}'::jsonb)`,
      [rewindRunId, project.id, repo.id, PIPELINE_PATH, serviceAccountPrincipalId, "sha-same-commit", automationRunId],
    );

    const { rows } = await rig.pool.query(
      "select count(*)::int as n from runs where project_id = $1",
      [project.id],
    );
    expect((rows[0] as { n: number }).n).toBe(3);

    // And the reverse proof: a second *automation* Run over the same key is
    // rejected by the index, not by any app logic.
    const duplicateAutomationRunId = generateId("run");
    await expect(
      rig.pool.query(
        `insert into runs (id, project_id, pipeline_repository_id, pipeline_path, trigger_kind,
           triggered_by_principal_id, credential_principal_id, ref_branch, ref_sha,
           definition, definition_files)
         values ($1, $2, $3, $4, 'automation', $5, $5, 'main', $6, '{}'::jsonb, '{}'::jsonb)`,
        [duplicateAutomationRunId, project.id, repo.id, PIPELINE_PATH, serviceAccountPrincipalId, "sha-same-commit"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("concurrency defaults to cancel: a new automation Run cancels the active one in the same commit", async () => {
    const project = await createProject(rig, ownerCookie, "concurrency-cancel");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("app", "on:\n  push:\n    branches: [main]\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-cc-a", yaml);

    await webhookAndSweep(rig, "push", "delivery-cc-1", pushPayload(repo, "main", "sha-cc-a"));

    registerPipeline(rig, repo, "main", "sha-cc-b", yaml);
    await webhookAndSweep(rig, "push", "delivery-cc-2", pushPayload(repo, "main", "sha-cc-b"));

    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(2);
    const runA = runs.find((run) => run.ref_sha === "sha-cc-a")!;
    const runB = runs.find((run) => run.ref_sha === "sha-cc-b")!;
    expect(runA.cancel_requested_at).not.toBeNull();
    expect(runB.cancel_requested_at).toBeNull();
  });

  it("concurrency: queue — the depth-1 snapshot replaces the queued entry and drains once the ref frees", async () => {
    const project = await createProject(rig, ownerCookie, "concurrency-queue");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("app", "concurrency: queue\non:\n  push:\n    branches: [main]\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-q-a", yaml);

    await webhookAndSweep(rig, "push", "delivery-q-1", pushPayload(repo, "main", "sha-q-a"));

    // Two more events while the Run is active: the third replaces the second
    // (depth 1 — the queue never grows).
    registerPipeline(rig, repo, "main", "sha-q-b", yaml);
    await webhookAndSweep(rig, "push", "delivery-q-2", pushPayload(repo, "main", "sha-q-b"));
    registerPipeline(rig, repo, "main", "sha-q-c", yaml);
    await webhookAndSweep(rig, "push", "delivery-q-3", pushPayload(repo, "main", "sha-q-c"));

    const pending = await rig.pool.query(
      "select ref_sha, count(*)::int as n from pending_automation_runs where project_id = $1 group by ref_sha",
      [project.id],
    );
    expect(pending.rows).toEqual([{ ref_sha: "sha-q-c", n: 1 }]);

    // The active Run ends; the sweep drains the snapshot.
    await rig.pool.query("update runs set ended_at = now() where ref_sha = $1", ["sha-q-a"]);
    await sweep(rig);

    const runs = await runsOf(rig, project.id);
    const active = runs.find((run) => run.ended_at === null)!;
    expect(active.ref_sha).toBe("sha-q-c");
    const left = await rig.pool.query(
      "select count(*)::int as n from pending_automation_runs where project_id = $1",
      [project.id],
    );
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  it("cron: overlap is skipped visibly, and a schedule lives only on the default branch — after merge", async () => {
    const project = await createProject(rig, ownerCookie, "cron");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const scheduleYaml = pipelineYaml(
      "app",
      "on:\n  schedule: ['* * * * *']\nsteps:\n  build:\n    run: echo build\n",
    );
    registerPipeline(rig, repo, "main", "sha-cron-1", scheduleYaml);

    // Fill the cache via a push (a schedule-only Pipeline is not
    // push-triggered). This sweep also claims minute 00:00's watermark.
    await webhookAndSweep(rig, "push", "delivery-cron-1", pushPayload(repo, "main", "sha-cron-1"));
    expect(await runsOf(rig, project.id)).toHaveLength(0);

    // A minute later the schedule sweep fires (one evaluation per minute).
    rig.setClock(new Date("2026-01-01T00:01:00.000Z"));
    await sweep(rig);
    const firstRuns = await runsOf(rig, project.id);
    expect(firstRuns).toHaveLength(1);
    expect(firstRuns[0]!.ref_branch).toBe("main");
    expect(firstRuns[0]!.ref_sha).toBe("sha-cron-1");

    // A schedule on a branch is dead until merged: the definition is read
    // from the default branch. Register a second Pipeline file that exists
    // ONLY on `feature`.
    registerPipeline(rig, repo, "feature", "sha-cron-feature", scheduleYaml);
    registerFileAt(rig, repo, "sha-cron-feature", ".factory/nightly.yaml", pipelineYaml("app", "on:\n  schedule: ['* * * * *']\nsteps:\n  nightly:\n    run: echo nightly\n"));
    await webhookAndSweep(rig, "push", "delivery-cron-2", pushPayload(repo, "feature", "sha-cron-feature", [".factory/nightly.yaml"]));

    // The default branch moves to a new commit (same schedule). The active
    // Run now overlaps at a *different* SHA — a genuine overlap: skipped,
    // visibly, and recorded.
    registerPipeline(rig, repo, "main", "sha-cron-2", scheduleYaml);
    rig.setClock(new Date("2026-01-01T00:02:00.000Z"));
    await sweep(rig);

    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(1); // no second Run from the overlap or from the un-merged branch schedule.

    // The skip is visible to any Project member, keyset newest first.
    const skips = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/automation/cron-skips`, {
      headers: { cookie: ownerCookie },
    });
    expect(skips.status).toBe(200);
    const page = (await skips.json()) as {
      skips: { reason: string; refSha: string; pipelinePath: string }[];
    };
    expect(page.skips).toHaveLength(1);
    expect(page.skips[0]!.reason).toBe("run-active");
    expect(page.skips[0]!.refSha).toBe("sha-cron-2");
    expect(page.skips[0]!.pipelinePath).toBe(PIPELINE_PATH);
  });

  it("branch deleted cancels the branch's automation Runs — including awaiting-human", async () => {
    const project = await createProject(rig, ownerCookie, "cancel-delete");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    registerPipeline(
      rig,
      repo,
      "feature",
      "sha-ah-feature",
      pipelineYaml(
        "app",
        "concurrency: cancel\non:\n  push:\n    branches: [feature]\nsteps:\n  review:\n    promptFile: prompts/review.md\n    ask:\n      group: reviewers\n      kind: approval\n",
      ),
    );
    registerFileAt(rig, repo, "sha-ah-feature", "prompts/review.md", "Review the work.\n");

    // The event + sweep birth the Run with a ready `review` StepRun.
    await webhookAndSweep(rig, "push", "delivery-ah-1", pushPayload(repo, "feature", "sha-ah-feature"));
    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.id;

    // The reviewers Group the ask: addresses (a Project member inside).
    const groupResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "reviewers" }),
    });
    expect(groupResponse.status).toBe(201);
    const group = (await groupResponse.json()) as { id: string };
    const added = await rig.fetchWithCsrf(`${rig.baseUrl}/groups/${group.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ principalId: ownerPrincipalId }),
    });
    expect(added.status).toBe(200);

    // The Runner's claim is FIFO across the whole rig (claim_step_run.sql is
    // not Project-scoped), and earlier tests left abandoned `ready` rows that
    // would be claimed first. They are fixtures, not protocol — retire them
    // by SQL so this test's own `review` StepRun is the only ready row.
    await rig.pool.query(
      "update step_runs set outcome = 'failed', reason = 'abandoned fixture of an earlier seam test' where run_id <> $1 and outcome = 'ready'",
      [runId],
    );

    // A Runner drives the Step into awaiting-human (the real protocol: claim
    // → upload session → POST question).
    const runner = await joinRunner(rig, ownerCookie);
    const claimed = await runner.client.claim(runner.secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } | null }).step_run;
    expect(stepRun).not.toBeNull();
    expect(stepRun!.id).toBe(
      (await rig.pool.query<{ id: string }>("select id from step_runs where run_id = $1 and step_key = 'review'", [runId])).rows[0]!.id,
    );
    const sessionJsonl = '{"type":"turn-1"}\n';
    const grants = await runner.client.uploads(runner.secret, stepRun!.id, {
      lease_token: stepRun!.lease_token,
      requests: [{ key: "session.jsonl", kind: "session" }],
    });
    const grant = (grants.body as { grants: { key: string; upload_url: string; blob_key: string }[] }).grants[0]!;
    rig.objectStore.putFromUrl(grant.upload_url, sessionJsonl);
    const asked = await runner.client.question(runner.secret, stepRun!.id, {
      lease_token: stepRun!.lease_token,
      question: { id: generateId("question"), group_id: group.id, kind: "approval", body: "Approve?" },
      ref: { branch: `run/${stepRun!.id}/review/t1-a1`, sha: "cafebabe" },
      session_blob_key: grant.blob_key,
      session_id: "sess-abc",
    });
    expect(asked.status).toBe(200);
    expect((await stepOutcomeOf(rig, runId, "review"))[0]!.outcome).toBe("awaiting-human");

    // The branch is deleted — the human declared the work irrelevant.
    await webhookAndSweep(rig, "delete", "delivery-ah-delete", {
      ref: "feature",
      ref_type: "branch",
      repository: { full_name: `${repo.owner}/${repo.name}` },
    });

    const after = await runsOf(rig, project.id);
    expect(after[0]!.cancel_requested_at).not.toBeNull();
    expect(after[0]!.outcome).toBe("cancelled");
    const step = (await stepOutcomeOf(rig, runId, "review"))[0]!;
    expect(step.outcome).toBe("cancelled");
    expect(step.reason).toBe("cancelled-by-automation");
  });

  it("PR close cancels the head-branch automation Run (the non-awaiting-human half)", async () => {
    const project = await createProject(rig, ownerCookie, "cancel-pr");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const prYaml = pipelineYaml("app", "on:\n  pullRequest: true\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-pr-cache-2", prYaml);
    registerFileAt(rig, repo, "sha-pr-head-2", PIPELINE_PATH, prYaml);
    const fullName = `${repo.owner}/${repo.name}`;

    // Fill the discovery cache with a push (no on: push — nothing triggers).
    await webhookAndSweep(rig, "push", "delivery-pr-fill-2", pushPayload(repo, "main", "sha-pr-cache-2"));

    await webhookAndSweep(rig, "pull_request", "delivery-pr-open", {
      action: "opened",
      repository: { full_name: fullName },
      pull_request: {
        head: { ref: "feature", sha: "sha-pr-head-2", repo: { full_name: fullName } },
        base: { repo: { full_name: fullName } },
      },
    });
    const runs = await runsOf(rig, project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ref_branch).toBe("feature");

    await webhookAndSweep(rig, "pull_request", "delivery-pr-close", {
      action: "closed",
      repository: { full_name: fullName },
      pull_request: {
        head: { ref: "feature", sha: "sha-pr-head-2", repo: { full_name: fullName } },
        base: { repo: { full_name: fullName } },
      },
    });
    const after = await runsOf(rig, project.id);
    expect(after[0]!.cancel_requested_at).not.toBeNull();
    expect(after[0]!.outcome).toBe("cancelled");
  });

  it("automation_enabled is an admin-only, audited kill switch", async () => {
    const project = await createProject(rig, ownerCookie, "kill-switch");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("app", "on:\n  push:\n    branches: [main]\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-ks-a", yaml);

    await webhookAndSweep(rig, "push", "delivery-ks-1", pushPayload(repo, "main", "sha-ks-a"));
    expect(await runsOf(rig, project.id)).toHaveLength(1);

    // A mere member cannot flip the switch.
    const member = await rig.loginAsGithub({
      githubUserId: 900_001,
      githubLogin: "member-900001",
      name: null,
      avatarUrl: null,
    });
    const { rows: memberRows } = await rig.pool.query(
      "select principal_id from users where github_user_id = 900001",
    );
    const memberPrincipalId = (memberRows[0] as { principal_id: string }).principal_id;
    const added = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ principalId: memberPrincipalId, role: "member" }),
    });
    expect(added.status).toBe(200);
    const asMember = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: member },
      body: JSON.stringify({ automationEnabled: false }),
    });
    expect(asMember.status).toBe(403);

    // The admin flips it off — every trigger goes silent at once.
    const off = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ automationEnabled: false }),
    });
    expect(off.status).toBe(200);

    const audit = await rig.pool.query(
      "select action, metadata from audit_log where project_id = $1 and action = 'project.automation_enabled_updated'",
      [project.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect((audit.rows[0] as { metadata: { automationEnabled: boolean } }).metadata.automationEnabled).toBe(false);

    registerPipeline(rig, repo, "main", "sha-ks-b", yaml);
    await webhookAndSweep(rig, "push", "delivery-ks-2", pushPayload(repo, "main", "sha-ks-b"));
    expect(await runsOf(rig, project.id)).toHaveLength(1);

    // Back on — automation breathes again.
    const on = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ automationEnabled: true }),
    });
    expect(on.status).toBe(200);
    registerPipeline(rig, repo, "main", "sha-ks-c", yaml);
    await webhookAndSweep(rig, "push", "delivery-ks-3", pushPayload(repo, "main", "sha-ks-c"));
    expect(await runsOf(rig, project.id)).toHaveLength(2);
  });

  it("comment events are not triggers: issue_comment is ack'ed and forgotten", async () => {
    const project = await createProject(rig, ownerCookie, "no-comment");
    const repo = await createRepository(rig, project.id, "app");
    await createServiceAccount(rig, project.id);
    const yaml = pipelineYaml("app", "on:\n  push:\n    branches: [main]\nsteps:\n  build:\n    run: echo build\n");
    registerPipeline(rig, repo, "main", "sha-comment", yaml);

    await webhookAndSweep(rig, "issue_comment", "delivery-comment-1", {
      action: "created",
      issue: { number: 42 },
      comment: { body: "/run" },
      repository: { full_name: `${repo.owner}/${repo.name}` },
    });
    expect(await runsOf(rig, project.id)).toHaveLength(0);
  });
});
