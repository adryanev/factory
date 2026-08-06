# Operating factory (self-host)

How to run factory on one machine from one compose file, how to upgrade it,
how to back it up, and — explicitly — what is not supported. This document
implements issue #21 (spec "Packaging self-host"); each section names the
acceptance criterion it answers.

## Architecture in one paragraph

One Docker Compose file (`compose.yaml`) starts everything: Postgres, a
Garage object store pinned exactly to v2.3.0 with single-node flags, a
one-shot migration service, and the control plane — a **single image** that
serves both the API and the web bundle it ships. Web and API cannot skew,
because they are one artifact; there is no base-URL configuration because
they share one origin. Runners are not in the compose file: they live on
machines of their own, joining the pool over outbound connections only.

## Hostnames and the reverse proxy

Two hostnames, always:

| Hostname | Points at | Purpose |
|---|---|---|
| `factory.example` | control-plane port 3000 | web UI + API (one origin) |
| `blob.factory.example` | Garage S3 port 3900 | presigned upload/download of artifacts, logs, sessions |

Garage needs its own hostname because SigV4 signs the `Host` header — it
cannot share an origin with the API. `factory-init.sh` writes
`FACTORY_WEB_URL` into `.env`; that is the value Commit Statuses link back
to and the CORS origin `garage-init` allows.

The reverse proxy **must have a read timeout ≥ 60 seconds**: `/claim`
long-polls 20–30s and live-tail holds up to 30s, so a proxy that kills
requests faster than that breaks Runners and log streaming. Caddy works
with zero configuration (its default read timeout is 5 minutes):

```caddyfile
factory.example {
    reverse_proxy 127.0.0.1:3000
}
blob.factory.example {
    reverse_proxy 127.0.0.1:3900
}
```

Nginx needs the timeout stated explicitly:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_read_timeout 60s;
}
```

TLS is terminated here, at the proxy — **not** inside the compose file (see
the unsupported list). HTTPS is mandatory for the webhook endpoint
(`https://factory.example/webhook/github`): payloads carry private
repository names, and the HMAC arrives in a header.

## First install

```sh
# 1. Secrets, with a real source of randomness — master key to a FILE
#    (deploy/keys/master.key, 0600), service passwords to .env. Nothing is
#    ever a `changeme`. The break-glass password is printed once here.
sh deploy/init/factory-init.sh

# 2. The GitHub App — manifest flow. Our manifest (deploy/github-app/
#    manifest.json) dictates the permissions; you only press "Create".
#    The private key lands straight in deploy/keys/, never on a clipboard.
sh deploy/github-app/register-app.sh

# 3. Start the stack: garage-init sets bucket CORS, migrate applies the
#    schema (one migrator, by construction), the control plane starts only
#    after both finish, and the boot-time migration gate refuses to serve
#    against a schema it does not recognize.
docker compose up -d
```

Then open `https://factory.example`, log in with your GitHub account, and
**install the GitHub App** on the repositories factory will touch. The
first user to log in is promoted to org owner; the bootstrap door then
closes permanently. There is no default admin credential to guess.

Order matters only in that register-app.sh writes the `GITHUB_*` fields
into `.env`; compose refuses to start with any of them missing (every
secret interpolation is `:?`-required — a wrong-looking-but-working
default is the failure mode this packaging is designed against).

## Configuration: what rides where

- **Key material → files** (compose `secrets`, read-only, from
  `./deploy/keys/`): the master key and the GitHub App private key. The
  path rides an env var; the material never does. A PEM is multi-line, and
  an env var puts material in `/proc/self/environ` — the master key rule
  (CVE-2025-66032) applies to both.
- **Service passwords → env vars** (`.env`): Postgres password, Garage
  keys, webhook secret, OAuth client secret, break-glass password. They are
  only useful while their service is reachable, and rotate with a restart.

`deploy/init/factory-init.sh` generates everything except the GitHub App
values; `deploy/github-app/register-app.sh` writes those. `deploy/.env.example`
documents the whole surface.

## Upgrade: a declared downtime

**Upgrading is downtime.** The control plane is a single image: when the
image changes, web and API change together. Migrations are not required to
be backward-compatible — the boot-time migration gate refuses to start a
new control plane against a schema it doesn't recognize, and an old control
plane cannot serve a new schema. The length of the outage is migration
time plus restart time.

A StepRun awaiting a human answer is untouched by an upgrade: it holds no
lease. A **running** StepRun is safe only if the outage is shorter than its
Runner's lease window — a Runner that cannot heartbeat long enough loses
its lease to the sweep, and that **consumes an `attempt`**. Therefore:

> An upgrade expected to last longer than one lease window **must be
> preceded by `desired_state: drain`** on every Runner (drain it in the UI,
> or via the Runner's local `drain` command), so it finishes its StepRuns
> and then idles until the outage is over.

Draining an `awaiting-human` StepRun is safe by construction — it holds no
lease and no Runner.

```sh
docker compose pull control-plane
docker compose up -d --no-deps control-plane
# the compose up starts migrate first: service_completed_successfully
# holds the control plane until migrations land; a red migrate container
# means the upgrade is blocked, loudly, not half-served.
```

There is no migration rollback. Backward is restore-from-backup (below).

## Backup: what is backed up, and what is kept out

```sh
sh deploy/backup/backup.sh [destination-dir]   # default ./backups
```

- **Postgres**: a transactional `pg_dump` streamed out of the container.
- **Garage**: object-level `s3 sync` to an S3-compatible target (set
  `BACKUP_S3_ENDPOINT`/`BACKUP_S3_TARGET`; without them the object sync is
  skipped). Data directories are **never** copied — a copy of a live
  service's data directory is a snapshot nobody can promise is consistent.
  Object sync is safe specifically because Artifacts are immutable and log
  objects are never rewritten after they finish; an object mid-write is
  missed, and a missed object is a half-finished log of a Run still in
  flight — a loss that is correct to accept.

**The master key is not in the backup set, and that is enforced by layout,
not by a warning:** the key lives at `./deploy/keys/master.key`, a plain
host directory bind-mounted read-only into the container — it is not a
Docker volume, and it is not under `./backups` or any path the backup
routine touches. The backup script additionally tripwires: if the key ever
ends up under the backup root, it refuses to run.

What losing the master key means, stated precisely: every user secret must
be re-entered. Historical runs, cost rows, and the audit log stay fully
readable — none of them is encrypted. Painful, not apocalyptic.

Restore: `psql` the dump into a fresh Postgres, then `s3 sync` the target
back into the `factory` bucket, then start the stack.

## Runners

The Runner ships as a **JavaScript tarball with Node ≥ 22 as the only
prerequisite** — pure JS end to end, so one tarball serves every platform:

```sh
sh deploy/runner/build-runner-tarball.sh <version>   # + .sha256, publish both
```

### macOS — the readable installer

Download the script and the tarball, read the script, then run it as root:

```sh
sudo ./deploy/runner/install-macos.sh \
  --tarball <path-or-url> --sha256 <published-checksum> \
  --control-plane https://factory.example
```

It verifies Node ≥ 22 and Xcode (it does not install Xcode — that needs an
Apple ID), verifies the checksum, creates the two OS users (`_factory` the
Runner, `_factoryjob` the agent — the separation is the isolation
boundary), installs the bundle, and registers a `launchd` daemon that runs
as `_factory` and survives reboots. It is idempotent: a failure mid-way is
fixed by re-running.

### Isolation as the gate to identity

The last step of the install is a postcondition: the agent user **must not
be able to read** the Runner's identity file (`sudo -u _factoryjob cat
runner.secret` must fail). Only then is the join command printed. But the
real gate lives in the binary: `factory-runner join` re-runs that same
verification and **refuses to exchange the join token when isolation is
broken** — so a half-finished installation produces a machine that never
has an identity, never appears in the pool, and never gets work. A Runner
whose identity file is world-readable, or whose agent runs as the wrong
user, simply cannot join.

```sh
sudo /usr/local/factory/runner/dist/main.js join \
  --control-plane https://factory.example \
  --token <one-time-token> --identity /usr/local/factory/runner/runner.secret \
  --agent-user _factoryjob
```

Mint the one-time token in the UI (org owner). Updates are manual: install
the new tarball and re-run — the Runner's version shows in the UI, and
outdated Runners are marked there.

### `exec:docker` needs an explicit opt-in

The Project egress allowlist is enforced only in `exec:host`, where the
Runner installs `pf` rules scoped to `_factoryjob`. `exec:docker` applies no
egress rules at all, so a Runner **refuses docker turns** and fails those
Step Runs with a reason naming the flag. Two ways forward:

- run those Steps with `runs_on: [exec:host]`, which is the enforced path; or
- install with `--allow-unenforced-docker-egress`, accepting that every
  docker turn on that machine reaches whatever the host reaches.

The opt-in has to be an installer flag: `launchd` gives the daemon no shell
environment, so `FACTORY_ALLOW_UNENFORCED_DOCKER_EGRESS` only works for a
hand-run Runner. Changing your mind means re-running the installer.
`docs/adr/0005-sandbox-egress.md` records why the default refuses.

## Explicitly unsupported

These are not accidents; they are declared boundaries (spec decision 9).
"Not supported" means not tested and not promised — not necessarily
impossible:

- **Kubernetes / Helm.** The compose file is the only deployment form that
  is tested.
- **High availability.** Two control-plane instances run correctly by
  mechanism (leases were built to handle it) but there is no load balancer,
  no documentation, and no test. Do not build on it silently.
- **Postgres HA, Garage multi-node, multi-region.** `replication_factor: 1`
  is a decision, not a leftover default.
- **Managed Postgres or Garage outside the compose file.** It is only env
  vars away, so it would probably work; it is not tested and not promised.
- **TLS termination inside the compose file.** Terminate at the reverse
  proxy. HTTPS is still mandatory for the webhook endpoint.
- **Runner on Windows.** There is no Windows path.
- **Migration rollback.** Forward only; backward is restore-from-backup.
