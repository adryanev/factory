import { describe, expect, it } from "vitest";
import { isValidKey } from "../key.js";

type IsValidKeyCase = {
  case: string;
  input: string;
  expected: boolean;
};

describe("isValidKey", () => {
  it.each([
    { case: "kosong", input: "", expected: false },
    { case: "hanya whitespace", input: "   ", expected: false },
    { case: "huruf besar di awal", input: "Frontend", expected: false },
    { case: "huruf besar di tengah", input: "frontEnd", expected: false },
    { case: "karakter di luar alfabet: @", input: "abc@", expected: false },
    { case: "karakter di luar alfabet: spasi", input: "abc def", expected: false },
    { case: "karakter di luar alfabet: emoji", input: "abc😀", expected: false },
    { case: "separator di awal: .abc", input: ".abc", expected: false },
    { case: "separator di akhir: abc.", input: "abc.", expected: true },
    { case: "separator berulang: a..b", input: "a..b", expected: true },
    { case: "separator berulang: a__b", input: "a__b", expected: true },
    { case: "separator berulang: a--b", input: "a--b", expected: true },
    { case: "separator titik di tengah", input: "a.b", expected: true },
    { case: "separator garis bawah di tengah", input: "a_b", expected: true },
    { case: "separator strip di tengah", input: "a-b", expected: true },
    { case: "tepat di batas: 63 karakter", input: "a".repeat(63), expected: true },
    { case: "tepat di batas: 64 karakter", input: "a".repeat(64), expected: true },
    { case: "satu di atas batas: 65 karakter", input: "a".repeat(65), expected: false },
    { case: "alfabet tertutup: digit di awal", input: "0abc", expected: true },
    { case: "alfabet tertutup: digit setelah karakter pertama", input: "a1", expected: true },
  ] satisfies IsValidKeyCase[])("$case", ({ input, expected }) => {
    expect(isValidKey(input)).toBe(expected);
  });
});
