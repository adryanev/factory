import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readIdentity, writeIdentity } from "./identity.js";

describe("Runner identity file", () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "runner-identity-test-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("returns null when no identity file exists yet — a Runner that has never joined", async () => {
    await withTempDir(async (dir) => {
      const identity = await readIdentity(path.join(dir, "identity.json"));
      expect(identity).toBeNull();
    });
  });

  it("round-trips runnerId + secret exactly, creating parent directories as needed", async () => {
    await withTempDir(async (dir) => {
      const identityFilePath = path.join(dir, "nested", "identity.json");
      await writeIdentity(identityFilePath, { runnerId: "runner_abc123", secret: "rnr_supersecretvalue" });

      const identity = await readIdentity(identityFilePath);
      expect(identity).toEqual({ runnerId: "runner_abc123", secret: "rnr_supersecretvalue" });
    });
  });

  it("writes the identity file with owner-only permissions — the secret is a bearer credential", async () => {
    await withTempDir(async (dir) => {
      const identityFilePath = path.join(dir, "identity.json");
      await writeIdentity(identityFilePath, { runnerId: "runner_abc123", secret: "rnr_x" });

      const stats = await stat(identityFilePath);
      // Mask to the permission bits only; mode also carries the file-type bits.
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  it("throws on a present-but-malformed identity file rather than silently treating it as unjoined", async () => {
    await withTempDir(async (dir) => {
      const identityFilePath = path.join(dir, "identity.json");
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await writeFile(identityFilePath, JSON.stringify({ runnerId: "runner_abc123" })); // missing `secret`

      await expect(readIdentity(identityFilePath)).rejects.toThrow(/valid Runner identity/);
    });
  });

  it("never writes the identity file in plaintext with a different shape than {runnerId, secret}", async () => {
    await withTempDir(async (dir) => {
      const identityFilePath = path.join(dir, "identity.json");
      await writeIdentity(identityFilePath, { runnerId: "runner_x", secret: "rnr_y" });
      const raw = JSON.parse(await readFile(identityFilePath, "utf-8"));
      expect(Object.keys(raw).sort()).toEqual(["runnerId", "secret"]);
    });
  });
});
