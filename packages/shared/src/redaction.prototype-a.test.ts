/**
 * PROTOTYPE — buang setelah #46 ditutup.
 * Varian A: `it.each` dengan array of object bernama, judul dari `$field`.
 * Baris "secret terpotong newline" sengaja dibuat merah.
 */
import { describe, expect, it } from "vitest";
import { createLiteralRedactor, REDACTION_PLACEHOLDER } from "./redaction.js";

describe("createLiteralRedactor (varian A: object rows)", () => {
  it.each([
    {
      case: "dua secret berbeda, masing-masing sekali",
      secrets: ["ghs_secret_token", "passw0rd"],
      input: "login with ghs_secret_token then passw0rd again",
      expected: "login with [redacted] then [redacted] again",
    },
    {
      case: "satu secret muncul berkali-kali",
      secrets: ["abc123"],
      input: "abc123 abc 123 abc123",
      expected: "[redacted] abc 123 [redacted]",
    },
    {
      case: "secret panjang menang atas secret pendek yang jadi substring-nya",
      secrets: ["abc", "abcdefgh"],
      input: "abcdefgh",
      expected: "[redacted]",
    },
    {
      case: "secret pendek tetap kena bila berdiri sendiri",
      secrets: ["abc", "abcdefgh"],
      input: "abc",
      expected: "[redacted]",
    },
    {
      case: "secret terpotong newline TIDAK diredaksi (batas best-effort)",
      secrets: ["ghs_abc"],
      input: "ghs_ab\nc",
      expected: "[redacted]", // SENGAJA MERAH — nilai benar: "ghs_ab\nc"
    },
    {
      case: "secret utuh kena",
      secrets: ["ghs_abc"],
      input: "ghs_abc",
      expected: "[redacted]",
    },
    {
      case: "daftar secret kosong = fungsi identitas",
      secrets: [],
      input: "anything at all",
      expected: "anything at all",
    },
    {
      case: "string kosong di daftar secret diabaikan",
      secrets: [""],
      input: "text",
      expected: "text",
    },
  ])("$case", ({ secrets, input, expected }) => {
    expect(createLiteralRedactor(secrets)(input)).toBe(expected);
  });

  it("memakai konstanta placeholder bersama", () => {
    expect(createLiteralRedactor(["secret"])("secret")).toBe(REDACTION_PLACEHOLDER);
  });
});
