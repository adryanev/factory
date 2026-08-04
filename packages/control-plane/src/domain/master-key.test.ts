/**
 * Master key file handling (AC3): the key material comes from a FILE, not an
 * env var; `key_version` per row makes rotation incremental and interruptible
 * because the `KeyRing` re-reads the file on every access — dropping version
 * 2 into the file is visible to the next call, and rows still on version 1
 * keep decrypting because version 1 is still in the file.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileKeyRing,
  loadMasterKeyFile,
  parseMasterKeyFile,
} from "../../src/domain/master-key.js";

const HEX_32 = (byte: number) => byte.toString(16).padStart(2, "0").repeat(32);

describe("master-key: file-backed keyring", () => {
  it("loads a valid file and returns its current version and 32-byte key", () => {
    const file = parseMasterKeyFile(
      JSON.stringify({ currentVersion: 1, keys: { "1": HEX_32(0xaa) } }),
    );
    expect(file.currentVersion).toBe(1);
    expect(loadMasterKeyFile).toBeTypeOf("function");
  });

  it("rejects a key that is not 32 bytes (the wrong-length guard, symmetric with nonce/tag)", () => {
    expect(() =>
      parseMasterKeyFile(JSON.stringify({ currentVersion: 1, keys: { "1": "aabb" } })),
    ).toThrow(/32 bytes/);
  });

  it("rejects a currentVersion with no corresponding key", () => {
    expect(() =>
      parseMasterKeyFile(JSON.stringify({ currentVersion: 2, keys: { "1": HEX_32(0xaa) } })),
    ).toThrow(/currentVersion 2 but no key/);
  });

  it("rejects malformed JSON and empty key sets loudly", () => {
    expect(() => parseMasterKeyFile("not json")).toThrow(/not valid JSON/);
    expect(() => parseMasterKeyFile(JSON.stringify({ currentVersion: 1, keys: {} }))).toThrow(
      /at least one key version/,
    );
  });

  it("AC3 — a keyring re-reads the file: dropping version 2 in makes the next currentVersion() see it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "master-key-test-"));
    try {
      const filePath = path.join(dir, "keys.json");
      await writeFile(filePath, JSON.stringify({ currentVersion: 1, keys: { "1": HEX_32(0xaa) } }));
      const keyring = createFileKeyRing(filePath);

      expect(keyring.currentVersion()).toBe(1);
      expect(keyring.key(1).toString("hex")).toBe(HEX_32(0xaa));

      // Rotation: the operator edits the file, no restart.
      await writeFile(
        filePath,
        JSON.stringify({ currentVersion: 2, keys: { "1": HEX_32(0xaa), "2": HEX_32(0xbb) } }),
      );
      expect(keyring.currentVersion()).toBe(2);
      expect(keyring.key(1).toString("hex")).toBe(HEX_32(0xaa)); // old version still decrypts.
      expect(keyring.key(2).toString("hex")).toBe(HEX_32(0xbb));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("AC3 — a missing file is loud at load time, not a silent empty keyring", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "master-key-test-"));
    try {
      const keyring = createFileKeyRing(path.join(dir, "does-not-exist.json"));
      expect(() => keyring.currentVersion()).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("AC3 — a version that leaves the file becomes undecryptable loudly, never silently empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "master-key-test-"));
    try {
      const filePath = path.join(dir, "keys.json");
      await writeFile(filePath, JSON.stringify({ currentVersion: 2, keys: { "2": HEX_32(0xbb) } }));
      const keyring = createFileKeyRing(filePath);
      expect(() => keyring.key(1)).toThrow(/no key for version 1/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
