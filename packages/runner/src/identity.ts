/**
 * Where a Runner's identity lives: a file on disk, never a hostname or an
 * IP (spec, and issue #5's binding acceptance criterion, verbatim). Written
 * once by `/join`'s response, read on every subsequent start.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RunnerIdentity {
  runnerId: string;
  secret: string;
}

function isRunnerIdentity(value: unknown): value is RunnerIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["runnerId"] === "string" &&
    typeof (value as Record<string, unknown>)["secret"] === "string"
  );
}

/** Reads the identity file, or `null` if this machine has never joined. Throws if the file exists but is not well-formed — a half-written or corrupted identity file must be loud, not silently treated as "not joined yet". */
export async function readIdentity(identityFilePath: string): Promise<RunnerIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(identityFilePath, "utf-8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRunnerIdentity(parsed)) {
    throw new Error(`${identityFilePath} does not contain a valid Runner identity`);
  }
  return parsed;
}

/** Writes the identity file, creating its parent directory if needed. Mode `0o600` — the secret is a bearer credential; nothing else on the machine should be able to read it by default. */
export async function writeIdentity(identityFilePath: string, identity: RunnerIdentity): Promise<void> {
  await mkdir(path.dirname(identityFilePath), { recursive: true });
  await writeFile(identityFilePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
