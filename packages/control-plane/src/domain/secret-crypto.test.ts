/**
 * The cryptographic invariants of secret storage (AC1, AC2):
 *
 *  - AES-256-GCM with AAD = secret id + owner Principal id. The decisive
 *    test here is the copied-row invariant: a row's ciphertext+nonce+tag,
 *    decrypted under the *wrong* owner Principal, must fail GCM tag
 *    verification — the invariant holds cryptographically, with no `WHERE`
 *    clause in sight.
 *  - nonce (12) and authTag (16) are separate fixed-length fields; a row
 *    with the wrong length is rejected loudly, so a bad length can never be
 *    written or read silently (AC2).
 */
import { describe, expect, it } from "vitest";
import type { RandomSource } from "../../src/deps.js";
import {
  buildSecretAad,
  decryptSecretValue,
  encryptSecretValue,
  SECRET_AUTH_TAG_LENGTH,
  SECRET_NONCE_LENGTH,
} from "../../src/domain/secret-crypto.js";

const KEY = Buffer.from("c0".repeat(32), "hex");

function fixedRandom(seed = 7): RandomSource {
  let state = seed;
  return {
    bytes: (length: number) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[i] = state % 256;
      }
      return out;
    },
  };
}

describe("secret-crypto: AES-256-GCM with principal-bound AAD", () => {
  it("round-trips a value under its own (secretId, ownerPrincipalId) AAD", () => {
    const aad = buildSecretAad("secret_aaa111", "serviceaccount_bbb222");
    const blob = encryptSecretValue(KEY, aad, "hunter2-credentials", fixedRandom());
    expect(decryptSecretValue(KEY, aad, blob)).toBe("hunter2-credentials");
  });

  it("AC1 — a row copied to another Principal fails to decrypt (GCM tag mismatch), with no WHERE clause involved", () => {
    const original = buildSecretAad("secret_aaa111", "serviceaccount_bbb222");
    const blob = encryptSecretValue(KEY, original, "hunter2-credentials", fixedRandom());

    // Copy the ciphertext row as-is to a different owner Principal — exactly
    // what a `UPDATE secrets SET owner_principal_id = ...` would produce.
    const copied = buildSecretAad("secret_aaa111", "serviceaccount_ccc333");
    expect(() => decryptSecretValue(KEY, copied, blob)).toThrow();
  });

  it("AC1 — the same applies when the secret id itself is rewritten to another row", () => {
    const original = buildSecretAad("secret_aaa111", "serviceaccount_bbb222");
    const blob = encryptSecretValue(KEY, original, "value", fixedRandom());
    const otherSecretId = buildSecretAad("secret_ddd444", "serviceaccount_bbb222");
    expect(() => decryptSecretValue(KEY, otherSecretId, blob)).toThrow();
  });

  it("AC1 — a different key (wrong key_version) also fails to decrypt", () => {
    const aad = buildSecretAad("secret_aaa111", "serviceaccount_bbb222");
    const blob = encryptSecretValue(KEY, aad, "value", fixedRandom());
    const otherKey = Buffer.from("d0".repeat(32), "hex");
    expect(() => decryptSecretValue(otherKey, aad, blob)).toThrow();
  });

  it("AC2 — the nonce is always exactly 12 bytes and the auth tag exactly 16, as separate fields", () => {
    const aad = buildSecretAad("secret_aaa111", "serviceaccount_bbb222");
    const blob = encryptSecretValue(KEY, aad, "value", fixedRandom());
    expect(blob.nonce).toHaveLength(SECRET_NONCE_LENGTH);
    expect(blob.authTag).toHaveLength(SECRET_AUTH_TAG_LENGTH);
    // They are distinct buffers, not one concatenated blob (AC2).
    expect(Buffer.isBuffer(blob.nonce)).toBe(true);
    expect(Buffer.isBuffer(blob.authTag)).toBe(true);
  });

  it("AC2 — a wrong-length nonce or tag is rejected loudly, never mis-parsed", () => {
    const aad = buildSecretAad("secret_aaa111", "serviceaccount_bbb222");
    const blob = encryptSecretValue(KEY, aad, "value", fixedRandom());
    expect(() =>
      decryptSecretValue(KEY, aad, { ...blob, nonce: blob.nonce.subarray(0, 8) }),
    ).toThrow(/nonce must be 12 bytes/);
    expect(() =>
      decryptSecretValue(KEY, aad, { ...blob, authTag: blob.authTag.subarray(0, 4) }),
    ).toThrow(/auth tag must be 16 bytes/);
  });

  it("a fresh nonce per encryption means the same value never encrypts to the same row twice", () => {
    const aad = buildSecretAad("secret_aaa111", "serviceaccount_bbb222");
    const first = encryptSecretValue(KEY, aad, "same-value", fixedRandom(1));
    const second = encryptSecretValue(KEY, aad, "same-value", fixedRandom(2));
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.nonce.equals(second.nonce)).toBe(false);
  });

  it("tampering with even one ciphertext byte fails authentication", () => {
    const aad = buildSecretAad("secret_aaa111", "serviceaccount_bbb222");
    const blob = encryptSecretValue(KEY, aad, "value", fixedRandom());
    const tampered = Buffer.from(blob.ciphertext);
    tampered[0]! ^= 0x01;
    expect(() => decryptSecretValue(KEY, aad, { ...blob, ciphertext: tampered })).toThrow();
  });
});
