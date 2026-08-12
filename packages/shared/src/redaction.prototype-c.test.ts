/**
 * PROTOTYPE — buang setelah #46 ditutup.
 * Varian C: tabel template-literal, judul dari `$case`.
 * Baris "secret terpotong newline" sengaja dibuat merah.
 */
import { describe, expect, it } from "vitest";
import { createLiteralRedactor, REDACTION_PLACEHOLDER } from "./redaction.js";

describe("createLiteralRedactor (varian C: template-literal table)", () => {
  it.each`
    case                                                              | secrets                                 | input                                              | expected
    ${"dua secret berbeda, masing-masing sekali"}                     | ${["ghs_secret_token", "passw0rd"]}     | ${"login with ghs_secret_token then passw0rd again"} | ${"login with [redacted] then [redacted] again"}
    ${"satu secret muncul berkali-kali"}                              | ${["abc123"]}                           | ${"abc123 abc 123 abc123"}                         | ${"[redacted] abc 123 [redacted]"}
    ${"secret panjang menang atas secret pendek substring-nya"}       | ${["abc", "abcdefgh"]}                  | ${"abcdefgh"}                                      | ${"[redacted]"}
    ${"secret pendek tetap kena bila berdiri sendiri"}                | ${["abc", "abcdefgh"]}                  | ${"abc"}                                           | ${"[redacted]"}
    ${"secret terpotong newline TIDAK diredaksi (batas best-effort)"} | ${["ghs_abc"]}                          | ${"ghs_ab\nc"}                                     | ${"[redacted]"}
    ${"secret utuh kena"}                                             | ${["ghs_abc"]}                          | ${"ghs_abc"}                                       | ${"[redacted]"}
    ${"daftar secret kosong = fungsi identitas"}                      | ${[]}                                   | ${"anything at all"}                               | ${"anything at all"}
    ${"string kosong di daftar secret diabaikan"}                     | ${[""]}                                 | ${"text"}                                          | ${"text"}
  `("$case", ({ secrets, input, expected }) => {
    expect(createLiteralRedactor(secrets)(input)).toBe(expected);
  });

  it("memakai konstanta placeholder bersama", () => {
    expect(createLiteralRedactor(["secret"])("secret")).toBe(REDACTION_PLACEHOLDER);
  });
});
