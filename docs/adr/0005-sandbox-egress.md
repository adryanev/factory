# 0005 — Sandbox egress: enforced in both `exec:host` and `exec:docker`

Status: Accepted (implemented by issue #22 — Tegakkan egress allowlist di
exec:docker, bukan sekadar menolaknya)

## Context

The spec's isolation model has one network rule (issue #10, AC6): the sandbox
gets **default-deny egress**, and the Project's allowlist is the only exception
set. `docs/SECURITY.md` states it as a property of the product, not of one
execution mode.

The allowlist travels correctly — the control plane puts it on the `/claim`
payload, the Runner reads it into `ClaimedStepRun.egressAllowlist`, and the
executor copies it onto the turn spec for both execution modes. What happens
next differs by mode:

- **`exec:host`** — `createFactoryHostProvider` calls `egress.apply(user,
  allowlist)` before the first spawn, which installs a `pf` anchor scoped to
  the agent's OS user, and removes it at teardown. Enforced.
- **`exec:docker`** — the built-in sandcastle provider is used as-is (AC1: the
  provider "dipakai apa adanya"), attached to a per-StepRun bridge network.
  For a long time nothing read `egressAllowlist` on this path at all: the
  sandbox could reach anything the host could reach.

`exec:docker` is the spec's *default* mode, so the mode most turns run in was
the mode with no egress enforcement. The previous decision (this ADR's first
life) was to **refuse** docker turns unless the operator passed
`--allow-unenforced-docker-egress` — a correct default, but a dead end: an
operator who needs docker mode still had no safe path, and a Linux Runner (no
`pf`) had no enforced mode at all.

Docker containers do not have an agent OS user to scope a `pf` anchor to;
filtering their traffic needs a different mechanism — a sidecar proxy on the
StepRun network, or an egress firewall on the bridge.

## Decisions

### `exec:docker` egress is enforced with a sidecar proxy on the per-StepRun network

The per-StepRun network already exists and is already created and torn down by
the Runner (`createNetwork`/`removeNetwork` in `agent-runtime/runtime.ts`), so
the enforcement rides that lifecycle:

- The per-StepRun network is created **`--internal`** — the step container has
  no route to anything outside the network, whatever it tries and however it
  tries it. A re-claimed turn whose network pre-exists fails closed unless the
  pre-existing network is internal: a crashed pre-upgrade Runner must not
  silently reopen egress.
- An **egress sidecar container** (the runner's own binary — the `egress-proxy`
  subcommand, mounted read-only from the runner's entry directory into a
  pinned Node image) joins the internal per-StepRun network *and* an ordinary
  upstream network. The sidecar is the step container's **only** path off the
  internal network.
- The step container's proxy env (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`,
  `NO_PROXY` cleared) routes every connection through the sidecar, which
  denies every destination not on the Project allowlist — **empty allowlist =
  deny everything**, the same semantics as `renderEgressRules` in host mode
  (exact hostname match, `*.` wildcard over subdomains only, case-insensitive,
  trailing dot ignored).
- The sidecar is a raw-socket forward proxy (CONNECT tunnels and absolute-form
  HTTP), so there is **no TLS MITM**: TLS bytes pass through untouched, and
  the allowlist check runs on the destination hostname, never on decrypted
  content.
- Teardown removes the sidecar first (a network cannot be removed while a
  container is still attached), then both networks — on turn end, on turn
  failure, and on cancel.
- An **undeployable sidecar fails the turn closed**: the step container must
  never start before its only exit exists.

The proxy's allowlist semantics are shared with host mode's `renderEgressRules`
by construction — both answer "is this host on the Project allowlist" with the
same matcher, so the two modes cannot drift apart.

### `--allow-unenforced-docker-egress` becomes an explicit opt-out, not the door

Enforcement is the default now: `exec:docker` turns run on an internal network
with the sidecar as their only exit, and the flag is no longer needed for the
normal path. The flag (and `FACTORY_ALLOW_UNENFORCED_DOCKER_EGRESS=1`) remains
for an operator who deliberately opts back into the pre-enforcement shape —
plain bridge network, no sidecar, no proxy env, the sandbox reaches whatever
the host reaches. Nothing silently downgrades: the flag is per Runner, visible
in its launch command, and the old `UnenforcedEgressError` refusal is gone
because there is no unenforced default left to refuse.

## Consequences

- A Runner upgraded to this version starts enforcing docker egress
  automatically: existing turns keep running (no refusal), but the sandbox can
  no longer reach hosts outside the Project allowlist. A Step whose Project
  allowlist is empty effectively runs without egress.
- Enforcement code ships inside the runner bundle (the `egress-proxy`
  subcommand), so the sidecar deploys from the exact artifact the Runner runs
  from — no separate image to build and keep patched; the sidecar's Node image
  is the pinned `node:20-alpine` default, overridable per Runner with
  `FACTORY_EGRESS_PROXY_IMAGE`.
- The sidecar must bind port 80 (busybox wget — the wget in every Alpine
  sandbox image — hardcodes the proxy port to the scheme default); the sidecar
  container runs as root inside its own container, so this is not a
  privilege concern.
- `exec:host` enforcement remains macOS-only (`pf`), and a Linux Runner in
  `exec:host` mode still has no enforced mode. `exec:docker` enforcement is
  platform-independent — it is docker networking, not host firewall rules.
- Every `exec:docker` test now asserts enforcement by default; only the
  opt-out test passes `allowUnenforcedDockerEgress: true`.
