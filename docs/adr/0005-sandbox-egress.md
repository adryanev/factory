# 0005 — Sandbox egress: enforced in `exec:host`, refused by default in `exec:docker`

Status: Accepted

## Context

The spec's isolation model has one network rule (issue #10, AC6): the sandbox
gets **default-deny egress**, and the Project's allowlist is the only exception
set. `docs/SECURITY.md` states it as a property of the product, not of one
execution mode.

The implementation does not honour that everywhere. The allowlist travels
correctly — the control plane puts it on the `/claim` payload, the Runner reads
it into `ClaimedStepRun.egressAllowlist`, and `turnSpecFor` copies it onto the
turn spec for both execution modes. What happens next differs:

- **`exec:host`** — `createFactoryHostProvider` calls `egress.apply(user,
  allowlist)` before the first spawn, which installs a `pf` anchor scoped to
  the agent's OS user, and removes it at teardown. Enforced.
- **`exec:docker`** — the built-in sandcastle provider is used as-is (AC1: the
  provider "dipakai apa adanya"). It attaches the container to a per-StepRun
  bridge network. Nothing reads `egressAllowlist` on this path at all. The
  sandbox can reach anything the host can reach.

`exec:docker` is the spec's *default* mode. So the mode that most turns run in
is the mode with no egress enforcement, and the mode nobody has to opt into is
the one where the documented control is absent.

Scoping a `pf` anchor to a user is what makes host mode enforceable. Docker
containers do not have an agent OS user to scope to; filtering their traffic
means a different mechanism — a sidecar proxy on the StepRun network, or an
egress firewall on the bridge. That is real work, and it is not this decision.

## Decisions

### One decision surface: egress is a property of the Runner, not of a mode

Host and docker are recorded here together on purpose. Splitting them invites
the reading that egress "works, except in docker" — an exception a reader
discovers only after trusting the general claim. The honest framing is that the
Runner enforces egress in exactly one mode today, and every other mode is
unprotected until proven otherwise.

### `exec:docker` is refused unless the operator accepts unenforced egress

`createTurnRuntime().startTurn` throws `UnenforcedEgressError` for any turn
with `runsOn: "docker"` unless `allowUnenforcedDockerEgress` is set. The
operator opts back in per Runner, with `--allow-unenforced-docker-egress` or
`FACTORY_ALLOW_UNENFORCED_DOCKER_EGRESS=1`.

Fail-closed is the choice because the alternative is a silent gap: a Project
carefully configures an allowlist, the Steps run in the default mode, and the
allowlist does nothing — with no signal anywhere that it did nothing. A Runner
that refuses is visible in the first Step Run it refuses.

The check sits at `startTurn`, the single entry point both turn kinds pass
through, so it cannot be bypassed by adding a third kind later.

### The refusal is a Step Run result, not a daemon crash

`startTurn` refuses synchronously, before any promise exists. The executor
therefore catches around the call and reports `failed` with
`reason: "turn fault: …"`, releasing the lease the normal way and revoking the
minted git tokens. An escaped throw would leave the row leased until the sweep,
and the claim loop would read it as a transport failure and re-claim the same
Step forever.

This also closes a pre-existing gap on the same path: `startTurn` already threw
synchronously for an unsupported turn kind, and that throw escaped the cycle.

### The gate is not the fix

Refusing is a correct default, not egress enforcement. Docker-mode filtering
still has to be built — a sidecar proxy on the per-StepRun network is the
likely shape, since the network already exists per StepRun and is already
created and torn down by the Runner. Until then:

- an operator who needs the allowlist enforced runs Steps with
  `runs_on: [exec:host]`;
- an operator who accepts the risk passes the flag and knows what it means;
- nobody gets unenforced egress by default.

`docs/SECURITY.md` states the same limit in the same terms.

## Consequences

- A Runner upgraded to this version stops running `exec:docker` Steps until
  the operator passes the flag. This is a deliberate breaking change to the
  default: the previous behaviour was to run them unprotected.
- The `pf` implementation is macOS-only, so `exec:host` enforcement is too. A
  Linux Runner has no enforced mode at all; it must use the flag, and its
  egress is unprotected.
- Every `exec:docker` test states `allowUnenforcedDockerEgress: true`
  explicitly, which keeps the unprotected path visible in the test suite
  instead of implied by a default.
