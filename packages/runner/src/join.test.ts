import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JoinTokenRejectedError, exchangeJoinToken, joinRunner } from "./join.js";
import type { IsolationProbe } from "./isolation.js";

const IDENTITY_PATH = "/run/factory/runner.secret";

describe("joinRunner — the isolation gate before identity", () => {
  it("exchanges the join token ONLY after isolation is verified — a readable secret never reaches the network", async () => {
    const order: string[] = [];
    const probe: IsolationProbe = {
      canAgentUserRead: async () => {
        order.push("verify");
        return false;
      },
    };
    const exchange = vi.fn(async (baseUrl: string, token: string) => {
      order.push(`exchange:${baseUrl}:${token}`);
      return { runnerId: "runner_abc", secret: "rnr_secret" };
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-join-"));
    try {
      await joinRunner({
        baseUrl: "https://factory.example",
        token: "jointoken_1",
        identityFilePath: path.join(dir, "identity.json"),
        probe,
        exchange,
      });
      expect(order).toEqual(["verify", "exchange:https://factory.example:jointoken_1"]);
      const written = JSON.parse(await readFile(path.join(dir, "identity.json"), "utf-8"));
      expect(written).toEqual({ runnerId: "runner_abc", secret: "rnr_secret" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to exchange the token — no network call at all — when isolation is broken", async () => {
    const probe: IsolationProbe = { canAgentUserRead: async () => true };
    const exchange = vi.fn(async () => {
      throw new Error("must not be called");
    });

    await expect(
      joinRunner({
        baseUrl: "https://factory.example",
        token: "jointoken_1",
        identityFilePath: IDENTITY_PATH,
        probe,
        exchange,
      }),
    ).rejects.toThrow(/isolation/);

    expect(exchange).not.toHaveBeenCalled();
  });

  it("never writes an identity file when isolation is broken", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-join-"));
    try {
      const identityFilePath = path.join(dir, "identity.json");
      const probe: IsolationProbe = { canAgentUserRead: async () => true };
      await expect(
        joinRunner({
          baseUrl: "https://factory.example",
          token: "jointoken_1",
          identityFilePath,
          probe,
          exchange: async () => ({ runnerId: "x", secret: "y" }),
        }),
      ).rejects.toThrow(/isolation/);
      await expect(readFile(identityFilePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exchangeJoinToken", () => {
  it("parses the snake_case wire shape", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ runner_id: "runner_7", secret: "rnr_s" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await exchangeJoinToken("https://factory.example", "jointoken_9");
      expect(result).toEqual({ runnerId: "runner_7", secret: "rnr_s" });
      expect(fetchMock).toHaveBeenCalledWith("https://factory.example/join", expect.objectContaining({ method: "POST" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps a 401 to a typed rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "invalid_token", message: "nope" }), { status: 401 })),
    );
    try {
      await expect(exchangeJoinToken("https://factory.example", "jointoken_9")).rejects.toThrow(
        JoinTokenRejectedError,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
