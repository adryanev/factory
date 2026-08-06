/**
 * The Runner's top-level control flow: claim, execute, repeat. `runOneCycle`
 * has always held the body of one iteration; this is the loop around it, and
 * the daemon's only long-lived activity.
 *
 * Two signals stop it, and they are not the same thing:
 *
 *  - **401** — the secret is wrong or revoked. The spec's error table has
 *    exactly one fatal status, and this is it (`decideOnStatus`).
 *  - **`desiredState` other than `active`** — the operator (or this process's
 *    own SIGTERM handler) asked the Runner to drain. Draining means "take no
 *    new work"; the turn already in flight is never interrupted, because the
 *    loop only observes the signal between cycles.
 *
 * Everything else is a backoff-and-retry. A control plane that is down must
 * not turn into a Runner that gives up — the lease sweep already covers the
 * work this Runner was holding, so the only correct behaviour is to keep
 * coming back.
 *
 * The idle heartbeat is what makes a Runner with nothing to do still visible
 * to an operator, and it is where `capsStale` is answered: the control plane
 * says its copy of the capabilities is out of date, and the Runner posts the
 * full report. That exchange has no other trigger.
 */
import { CURRENT_PROTOCOL_VERSION } from "@factory/shared";
import { decideOnStatus } from "./error-policy.js";
import { ProtocolError } from "./protocol/client.js";
import { hashCapabilities, type Capabilities } from "./capabilities.js";
import { runOneCycle, type StepRunExecutorDeps } from "./step-run-executor.js";

export interface ClaimLoopDeps extends StepRunExecutorDeps {
  /** The full probed report — sent whenever the control plane says its copy is stale. */
  capabilities: Capabilities;
  /** This Runner's tags, matched against each Step's `runsOn` by the claim query's containment check. */
  tags: string[];
  /** Wait between polls when nothing was claimable (spec: the Runner polls; the control plane never pushes). */
  idlePollIntervalMs?: number;
  /** Wait after a failed request, before returning to `/claim`. */
  backoffMs?: number;
  /** Injected so tests do not spend real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Reports progress at the boundary; defaults to `console`. */
  log?: (message: string) => void;
}

export interface ClaimLoopHandle {
  /**
   * Resolves when the loop has left for any reason — including the ones it
   * decides for itself (a revoked secret, an operator draining this Runner).
   * The daemon waits on this as well as on SIGTERM: a Runner whose secret was
   * revoked must exit, not sit idle holding a process open.
   */
  finished: Promise<void>;
  /** Stops claiming new work after the current cycle and resolves when the loop has left. */
  stop(): Promise<void>;
}

const DEFAULT_IDLE_POLL_INTERVAL_MS = 2_000;
const DEFAULT_BACKOFF_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts the loop and returns a handle. `slots` is fixed at 1: `runOneCycle`
 * executes a claimed turn to completion before returning, so one is the only
 * capacity this Runner can honestly report. Concurrency would mean several
 * cycles in flight and a real free-slot count; nothing asks for that yet.
 */
export function startClaimLoop(deps: ClaimLoopDeps): ClaimLoopHandle {
  const idlePollIntervalMs = deps.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
  const backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((message: string) => console.log(message));
  const capsHash = hashCapabilities(deps.capabilities);

  let stopping = false;

  const idleHeartbeat = async (): Promise<void> => {
    const reply = await deps.protocol.heartbeat({ leases: [], capsHash });
    if (reply.capsStale) {
      await deps.protocol.reportCapabilities({ capsHash, capabilities: deps.capabilities });
      log("runner: capabilities reported (control plane said its copy was stale)");
    }
    if (reply.desiredState !== "active") {
      log(`runner: control plane wants desired_state='${reply.desiredState}' — no longer claiming`);
      stopping = true;
    }
  };

  const done = (async (): Promise<void> => {
    log(`runner: claim loop started (caps ${capsHash.slice(0, 12)}, tags [${deps.tags.join(", ")}])`);
    while (!stopping) {
      try {
        const claimed = await runOneCycle(deps, {
          tags: deps.tags,
          slots: 1,
          protocolVersion: CURRENT_PROTOCOL_VERSION,
        });
        if (stopping) break;
        if (claimed) {
          // Something was available; go straight back for the next one rather
          // than sleeping through a queue that may still be full.
          continue;
        }
        await idleHeartbeat();
        if (stopping) break;
        await sleep(idlePollIntervalMs);
      } catch (error) {
        if (error instanceof ProtocolError && decideOnStatus(error.status) === "stop") {
          log(`runner: stopping — ${error.message}`);
          stopping = true;
          break;
        }
        log(`runner: cycle failed, retrying in ${backoffMs}ms — ${String(error)}`);
        await sleep(backoffMs);
      }
    }
    log("runner: claim loop stopped");
  })();

  return {
    finished: done,
    async stop() {
      stopping = true;
      await done;
    },
  };
}
