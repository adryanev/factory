import { describe, expect, it } from "vitest";
import { createLiteralRedactor, REDACTION_PLACEHOLDER } from "./redaction.js";

type RedactorCase = {
  case: string;
  secrets: string[];
  input: string;
  expected: string;
};

describe("createLiteralRedactor", () => {
  // lewati: input/karakter di luar alfabet — tidak ada alfabet yang diizinkan; createLiteralRedactor tidak memvalidasi input
  // lewati: input/separator — tidak ada format berseparator di redaction.ts
  // lewati: input/panjang — tidak ada batas panjang di redaction.ts
  it.each([
    {
      case: "daftar secret kosong = fungsi identitas",
      secrets: [],
      input: "anything at all",
      expected: "anything at all",
    },
    {
      case: "satu secret, satu kemunculan",
      secrets: ["ghs_abc"],
      input: "ghs_abc",
      expected: "[redacted]",
    },
    {
      case: "satu secret muncul berkali-kali",
      secrets: ["abc123"],
      input: "abc123 abc 123 abc123",
      expected: "[redacted] abc 123 [redacted]",
    },
    {
      case: "dua secret berbeda, masing-masing sekali",
      secrets: ["ghs_secret_token", "passw0rd"],
      input: "login with ghs_secret_token then passw0rd again",
      expected: "login with [redacted] then [redacted] again",
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
      case: "secret duplikat di daftar tidak mengubah hasil",
      secrets: ["abc", "abc"],
      input: "abc abc",
      expected: "[redacted] [redacted]",
    },
    {
      case: "string kosong di daftar secret diabaikan",
      secrets: [""],
      input: "text",
      expected: "text",
    },
    {
      case: "input kosong",
      secrets: ["abc"],
      input: "",
      expected: "",
    },
    {
      case: "input hanya whitespace",
      secrets: ["abc"],
      input: "   ",
      expected: "   ",
    },
    {
      case: "input beda case TIDAK diredaksi (pencocokan literal peka huruf besar-kecil)",
      secrets: ["ghs_abc"],
      input: "GHS_ABC",
      expected: "GHS_ABC",
    },
    {
      case: "secret terpotong newline TIDAK diredaksi (batas best-effort)",
      secrets: ["ghs_abc"],
      input: "ghs_ab\nc",
      expected: "ghs_ab\nc",
    },
  ] satisfies RedactorCase[])("$case", ({ secrets, input, expected }) => {
    expect(createLiteralRedactor(secrets)(input)).toBe(expected);
  });

  it("memakai konstanta placeholder bersama", () => {
    const redact = createLiteralRedactor(["secret"]);
    expect(redact("secret")).toBe(REDACTION_PLACEHOLDER);
  });
});
