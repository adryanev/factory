/**
 * Vitest global setup: the testcontainers reaper (Ryuk) is a host-wide
 * singleton, and every container start — every Postgres rig, the Garage
 * contract test — first connects to its socket inside the library with a
 * hardcoded 4-second budget (testcontainers 10.28, reaper.ts). Under
 * parallel load (four package suites, a dozen vitest workers, a busy
 * machine) that fixed budget is occasionally too short: the connect either
 * fast-fails with "Failed to connect to Reaper" or hangs past the vitest
 * hook timeout, and whichever suite happens to boot a container in that
 * window fails at the suite level (issue #31).
 *
 * This setup replaces the per-suite race with one condition-based wait done
 * once, before any worker boots a container: ensure a reaper exists AND its
 * socket actually accepts connections, polling the socket itself with a
 * generous bounded budget. Every suite's connect afterwards is a formality.
 * The wait is on the real readiness signal (the socket accepting), never on
 * a fixed duration.
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { GenericContainer, ImageName, Wait, getContainerRuntimeClient } from "testcontainers";
import { CONTAINER_READY_BUDGET_MS } from "./postgres-container.js";

const REAPER_IMAGE = process.env["RYUK_CONTAINER_IMAGE"] ?? "testcontainers/ryuk:0.11.0";
const SOCKET_READY_BUDGET_MS = 60_000;
const SOCKET_POLL_INTERVAL_MS = 500;
const RYUK_LABEL = "org.testcontainers.ryuk";

/** The reaper's readiness signal is its TCP socket accepting — probe it, not a sleep. */
function acceptsConnections(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.setTimeout(2_000);
    const done = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

async function waitForReaperSocket(host: string, port: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SOCKET_READY_BUDGET_MS) {
    if (await acceptsConnections(host, port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SOCKET_POLL_INTERVAL_MS));
  }
  throw new Error(`Reaper at ${host}:${port} did not accept a connection within ${SOCKET_READY_BUDGET_MS}ms`);
}

interface ReaperCandidate {
  State: string;
  Labels: Record<string, string>;
  Ports: { PrivatePort?: number; PublicPort?: number }[];
}

/** The same predicate testcontainers' own `findReaperContainer` uses. */
function findRunningReaper(containers: ReaperCandidate[]): ReaperCandidate | undefined {
  return containers.find(
    (container) =>
      container.State === "running" &&
      container.Labels[RYUK_LABEL] === "true" &&
      container.Labels["TESTCONTAINERS_RYUK_TEST_LABEL"] !== "true",
  );
}

function reaperPortOf(container: ReaperCandidate): number | undefined {
  return container.Ports.find((port) => port.PrivatePort === 8080)?.PublicPort;
}

/**
 * The reaper image is AutoRemove: docker removes the container itself the
 * moment it stops, so the library's `stop()` (stop, then an explicit remove)
 * races that removal. Docker answers the race differently depending on how far
 * it got — 409 while the removal is still in flight, 404 once it has already
 * finished. Both mean the container is gone, which is exactly what teardown
 * asked for; anything else is a real failure.
 */
function containerAlreadyGone(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const statusCode: unknown = (error as { statusCode?: unknown }).statusCode;
  if (statusCode === 409 || statusCode === 404) {
    return true;
  }
  return error.message.includes("is already in progress") || error.message.includes("no such container");
}

export default async function warmUpReaper(): Promise<() => Promise<void>> {
  if (process.env["TESTCONTAINERS_RYUK_DISABLED"] === "true") {
    return async () => {};
  }

  const client = await getContainerRuntimeClient();
  const host = client.info.containerRuntime.host;

  // An already-running, accepting reaper (left by a previous run or another
  // package) is perfect — verify it and leave it alone.
  const existing = findRunningReaper(await client.container.list());
  if (existing !== undefined) {
    const port = reaperPortOf(existing);
    if (port === undefined) {
      throw new Error("Found a running reaper with no 8080 mapping; cannot verify its readiness");
    }
    await waitForReaperSocket(host, port);
    return async () => {};
  }

  // Otherwise start one exactly as testcontainers would (same image, labels,
  // socket mount, port) — but with readiness proven by the socket accepting,
  // not by the library's fixed 4-second connect budget.
  const sessionId = randomUUID();
  const ryukPort = process.env["TESTCONTAINERS_RYUK_PORT"];
  const container = new GenericContainer(ImageName.fromString(REAPER_IMAGE).string)
    .withName(`testcontainers-ryuk-${sessionId}`)
    .withExposedPorts(
      ryukPort !== undefined ? { container: 8080, host: parseInt(ryukPort, 10) } : 8080,
    )
    .withBindMounts([{ source: client.info.containerRuntime.remoteSocketPath, target: "/var/run/docker.sock" }])
    .withLabels({ "org.testcontainers.session-id": sessionId })
    .withWaitStrategy(Wait.forLogMessage(/.*Started.*/))
    .withStartupTimeout(CONTAINER_READY_BUDGET_MS);

  const started = await container.start();
  await waitForReaperSocket(started.getHost(), started.getMappedPort(8080));
  return async () => {
    try {
      await started.stop();
    } catch (error) {
      if (!containerAlreadyGone(error)) {
        throw error;
      }
    }
  };
}
