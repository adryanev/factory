/**
 * Password hashing for the break-glass account only — the one place in this
 * system a password exists (spec: "Auth, tim, dan otorisasi" — "satu akun
 * break-glass lokal"). `node:crypto`'s `scrypt` is used instead of adding a
 * bcrypt/argon2 dependency: it is memory-hard, it ships in Node's standard
 * library (the "use the standard library" rule in the engineering
 * practice), and there is exactly one password in this whole system to
 * hash, so a dedicated password-hashing package buys nothing here that the
 * stdlib doesn't already give for free.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;

/** `scrypt$<saltHex>$<hashHex>` — self-describing so the format can change later without breaking rows already written. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex!, "hex");
  const expected = Buffer.from(hashHex!, "hex");
  const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
