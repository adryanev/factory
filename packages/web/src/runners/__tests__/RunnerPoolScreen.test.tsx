/**
 * Issue #33, AC "Tes menembus lewat layar" — the Runner pool screen renders
 * online/offline, version, heartbeat, protocol 426, and leases, and drives
 * drain/revoke through the admin POST endpoints (mock fetch; the seam-1
 * suite covers the real wire paths).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunnerPoolScreen } from "../RunnerPoolScreen";

const RUNNER_ACTIVE = {
  id: "runner_abcdef",
  desiredState: "active",
  tags: [],
  slots: 4,
  protocolVersion: 1,
  releaseVersion: "v0.0.1",
  lastHeartbeatAt: "2026-08-11T08:00:10.000Z",
  activeLeases: 2,
};
const RUNNER_OLD = {
  id: "runner_oldproto",
  desiredState: "active",
  tags: ["macos"],
  slots: 1,
  protocolVersion: 999,
  releaseVersion: "v0.0.0",
  lastHeartbeatAt: "2026-08-10T08:00:00.000Z",
  activeLeases: 0,
};

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function mockPool(initialRunners: unknown[], onPost?: (url: string) => void): ReturnType<typeof vi.fn> {
  const runners = [...initialRunners];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (init?.method === "POST") {
      onPost?.(url);
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" };
    }
    if (init === undefined || init.method === undefined || init.method === "GET") {
      return { ok: true, status: 200, json: async () => ({ runners }), text: async () => JSON.stringify({ runners }) };
    }
    return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
  });
  return fetchImpl;
}

describe("RunnerPoolScreen", () => {
  const NOW = Date.parse("2026-08-11T08:00:30.000Z");

  it("renders the pool through the screen: online/offline, version, heartbeat, leases, and the 426 protocol badge", async () => {
    vi.stubGlobal("fetch", mockPool([RUNNER_ACTIVE, RUNNER_OLD]));

    render(<RunnerPoolScreen now={() => NOW} pollIntervalMs={60_000} />);

    const list = await screen.findByTestId("runner-pool");
    const activeItem = within(list).getByText("runner_abcdef").closest("li")!;
    expect(within(activeItem).getByText("Online")).toBeInTheDocument();
    expect(within(activeItem).getByText("active")).toBeInTheDocument();
    expect(within(activeItem).getByText(/v0\.0\.1/)).toBeInTheDocument();
    expect(within(activeItem).getByText(/2 leases/)).toBeInTheDocument();
    expect(within(activeItem).getByText(/4 slots/)).toBeInTheDocument();

    const oldItem = within(list).getByText("runner_oldproto").closest("li")!;
    expect(within(oldItem).getByText("Offline")).toBeInTheDocument();
    expect(within(oldItem).getByTestId("protocol-426-runner_oldproto")).toHaveTextContent(/426/);
    expect(within(oldItem).getByText(/macos/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("drains through the admin endpoint and reflects the new desired state after the refresh", async () => {
    const posted: string[] = [];
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockPool([RUNNER_ACTIVE], (url) => {
        posted.push(url);
        return [];
      }),
    );

    render(<RunnerPoolScreen now={() => NOW} pollIntervalMs={60_000} />);

    const list = await screen.findByTestId("runner-pool");
    const item = within(list).getByText("runner_abcdef").closest("li")!;
    await user.click(within(item).getByRole("button", { name: "Drain" }));

    await waitFor(() => expect(posted).toEqual(["/runners/runner_abcdef/drain"]));
    vi.unstubAllGlobals();
  });

  it("revoke needs an explicit confirmation before posting", async () => {
    const posted: string[] = [];
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      mockPool([RUNNER_ACTIVE], (url) => {
        posted.push(url);
        return [];
      }),
    );

    render(<RunnerPoolScreen now={() => NOW} pollIntervalMs={60_000} />);

    const list = await screen.findByTestId("runner-pool");
    const item = within(list).getByText("runner_abcdef").closest("li")!;

    await user.click(within(item).getByRole("button", { name: "Revoke" }));
    expect(posted).toEqual([]);
    expect(within(item).getByRole("button", { name: "Confirm revoke" })).toBeInTheDocument();

    await user.click(within(item).getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(posted).toEqual(["/runners/runner_abcdef/revoke"]));
    vi.unstubAllGlobals();
  });

  it("shows the empty state for an empty pool", async () => {
    vi.stubGlobal("fetch", mockPool([]));

    render(<RunnerPoolScreen now={() => NOW} pollIntervalMs={60_000} />);

    expect(await screen.findByText(/The Runner pool is empty/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("surfaces a fetch error through the screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));

    render(<RunnerPoolScreen now={() => NOW} pollIntervalMs={60_000} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load the Runner pool/);
    vi.unstubAllGlobals();
  });
});
