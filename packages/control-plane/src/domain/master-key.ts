/**
 * The master key: the key material lives in a FILE, never an environment
 * variable (spec: "Master key dari file, bukan environment variable").
 * The reason is structural, not stylistic — `/proc/self/environ` is a real
 * exfiltration vector (CVE-2025-66032): a prompt-injected agent that tricks
 * a step into dumping the process environment can steal `ENV=...` keys, but
 * a key that lives in a file on the control-plane host is not something any
 * Runner-side or sandbox-side process ever holds. The path to the file may
 * ride an env var (`FACTORY_MASTER_KEY_FILE`); the key material itself never
 * does.
 *
 * The file is a small JSON document holding every *still-valid* key version
 * plus the current one, so rotation is incremental and interruptible:
 *
 *   {
 *     "currentVersion": 2,
 *     "keys": { "1": "<64 hex chars = 32 bytes>", "2": "..." }
 *   }
 *
 * `KeyRing` re-reads the file on every access. That is what makes rotation
 * work without a restart: an operator drops version N+1 into the file, the
 * next `currentVersion()` sees it, and rows encrypted under older versions
 * still decrypt because their versions are still in the file. A rotation
 * interrupted halfway therefore leaves a mix of versions behind that all
 * decrypt correctly — and never disturbs a Run already in flight, whose
 * claim payload already carried its plaintext values into the Runner.
 */
import { readFileSync } from "node:fs";

export const MASTER_KEY_BYTES = 32;
export const MASTER_KEY_HEX_LENGTH = MASTER_KEY_BYTES * 2;

export interface MasterKeyFile {
  currentVersion: number;
  /** version -> 32-byte key, hex-encoded (64 chars). */
  keys: Record<string, string>;
}

/**
 * Parses the raw JSON text of a master key file. Pure — unit tests exercise
 * every failure shape (malformed JSON, a non-32-byte key, a currentVersion
 * pointing at a missing version) without a real file on disk.
 */
export function parseMasterKeyFile(raw: string): MasterKeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("master key file is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("master key file must be a JSON object");
  }
  const { currentVersion, keys } = parsed as { currentVersion?: unknown; keys?: unknown };
  if (typeof currentVersion !== "number" || !Number.isInteger(currentVersion)) {
    throw new Error("master key file must declare an integer currentVersion");
  }
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    throw new Error("master key file must declare a keys object (version -> hex key)");
  }
  const entries = Object.entries(keys as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("master key file must declare at least one key version");
  }
  for (const [version, key] of entries) {
    if (!/^\d+$/.test(version)) {
      throw new Error(`master key version '${version}' must be a non-negative integer`);
    }
    if (typeof key !== "string" || !/^[0-9a-f]+$/i.test(key) || key.length !== MASTER_KEY_HEX_LENGTH) {
      throw new Error(
        `master key for version ${version} must be ${MASTER_KEY_BYTES} bytes as ${MASTER_KEY_HEX_LENGTH} hex chars`,
      );
    }
  }
  if (!(String(currentVersion) in keys)) {
    throw new Error(`master key file declares currentVersion ${currentVersion} but no key for that version`);
  }
  return { currentVersion, keys: keys as Record<string, string> };
}

/** Loads and validates the master key file at `filePath`. */
export function loadMasterKeyFile(filePath: string): MasterKeyFile {
  return parseMasterKeyFile(readFileSync(filePath, "utf-8"));
}

/** The raw 32-byte key for a version, or a loud error when the version is gone from the file. */
export function masterKeyForVersion(file: MasterKeyFile, version: number): Buffer {
  const hex = file.keys[String(version)];
  if (hex === undefined) {
    throw new Error(`master key file has no key for version ${version}`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * The injectable face of the master key. Reads the file on every call so a
 * rotation that merely edits the file (adding a version) is picked up by the
 * next call — no restart, and an interrupted rotation still decrypts.
 */
export interface KeyRing {
  currentVersion(): number;
  key(version: number): Buffer;
}

export function createFileKeyRing(filePath: string): KeyRing {
  return {
    currentVersion() {
      return loadMasterKeyFile(filePath).currentVersion;
    },
    key(version) {
      return masterKeyForVersion(loadMasterKeyFile(filePath), version);
    },
  };
}
