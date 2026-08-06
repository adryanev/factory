/**
 * AES-256-GCM envelope for stored secret values, with **AAD = secret id +
 * owner Principal id** (spec, verbatim). Because the owner Principal id is
 * part of the authenticated header, a row copied to a different Principal
 * *cannot* decrypt: GCM tag verification fails on the very first byte the
 * wrong AAD authenticates. That is the "invarian kriptografis, bukan klausa
 * WHERE" — enforced by the cipher, not by an application-level query filter.
 *
 * `nonce` and `authTag` are deliberately separate fields, mirroring separate
 * `bytea` columns in the `secrets` table (spec: "Nonce dan auth tag kolom
 * terpisah, bukan disambung jadi satu bytea, supaya panjang yang salah
 * mustahil ditulis diam-diam"). GCM demands a fixed 12-byte nonce and a
 * 16-byte tag; a row that violates either length is rejected by the
 * decryptor rather than silently mis-parsed.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { RandomSource } from "../deps.js";

export const SECRET_NONCE_LENGTH = 12;
export const SECRET_AUTH_TAG_LENGTH = 16;
/** Values under this size are rejected at store time (ticket 10: "nilai di bawah 6 byte ditolak saat disimpan"). */
export const SECRET_MIN_VALUE_BYTES = 6;

/** A value ciphertext plus the two GCM fields that must each be written to their own column. */
export interface SecretCipherBlob {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

/**
 * The AAD: `secretId` then the owning Principal id, joined by `\0`. Both are
 * prefixed-base32 ids (alphanumeric only — `@factory/shared`), so the NUL is
 * an unambiguous separator and the pair cannot collide with another
 * (id, principal) combination.
 */
export function buildSecretAad(secretId: string, ownerPrincipalId: string): Buffer {
  return Buffer.from(`${secretId}\0${ownerPrincipalId}`, "utf-8");
}

/** Encrypts a UTF-8 secret value under `key` with the given AAD. `nonce` is fresh per call from the injected `random` source. */
export function encryptSecretValue(
  key: Buffer,
  aad: Buffer,
  value: string,
  random: RandomSource,
): SecretCipherBlob {
  const nonce = Buffer.from(random.bytes(SECRET_NONCE_LENGTH));
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

/** Decrypts a `SecretCipherBlob`. Throws on a wrong key, a wrong AAD (copied-to-another-Principal row), or a malformed nonce/tag length. */
export function decryptSecretValue(key: Buffer, aad: Buffer, blob: SecretCipherBlob): string {
  if (blob.nonce.length !== SECRET_NONCE_LENGTH) {
    throw new Error(`secret nonce must be ${SECRET_NONCE_LENGTH} bytes, got ${blob.nonce.length}`);
  }
  if (blob.authTag.length !== SECRET_AUTH_TAG_LENGTH) {
    throw new Error(`secret auth tag must be ${SECRET_AUTH_TAG_LENGTH} bytes, got ${blob.authTag.length}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, blob.nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(blob.authTag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString("utf-8");
}
