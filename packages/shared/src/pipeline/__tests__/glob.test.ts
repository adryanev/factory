import { describe, expect, it } from "vitest";
import { anyGlobMatches, globMatches, globToRegExp } from "../glob.js";

type GlobToRegExpCase = {
  case: string;
  pattern: string;
  expectedSource: string;
};

describe("globToRegExp", () => {
  // lewati: pattern/karakter di luar alfabet & beda case — alfabet tak terbatas; glob.ts:13: "Everything else is a literal"
  // lewati: pattern/panjang — tidak ada batas panjang di glob.ts:22-42 (loop i < pattern.length)
  it.each([
    { case: "pola kosong", pattern: "", expectedSource: "^$" },
    { case: "whitespace lolos sebagai literal", pattern: " a", expectedSource: "^ a$" },
    { case: "literal biasa", pattern: "main", expectedSource: "^main$" },
    { case: "slash menerus sebagai literal", pattern: "a/b", expectedSource: "^a\\/b$" },
    { case: "slash di akhir pola", pattern: "feat/", expectedSource: "^feat\\/$" },
    { case: "titik diescape", pattern: "a.b", expectedSource: "^a\\.b$" },
    { case: "kurung diescape", pattern: "(hotfix)", expectedSource: "^\\(hotfix\\)$" },
    { case: "plus diescape", pattern: "a+b", expectedSource: "^a\\+b$" },
    { case: "bintang dalam satu segmen", pattern: "feat/*", expectedSource: "^feat\\/[^/]*$" },
    { case: "bintang di tengah pola", pattern: "*a*", expectedSource: "^[^/]*a[^/]*$" },
    { case: "bintang dengan ekstensi", pattern: "*.yaml", expectedSource: "^[^/]*\\.yaml$" },
    { case: "dua bintang lintas segmen", pattern: "docs/**", expectedSource: "^docs\\/.*$" },
    { case: "dua bintang polos", pattern: "**", expectedSource: "^.*$" },
    { case: "dua bintang di tengah pola", pattern: "a**b", expectedSource: "^a.*b$" },
    { case: "dua bintang lalu satu bintang", pattern: "**/*.yaml", expectedSource: "^.*\\/[^/]*\\.yaml$" },
    { case: "tiga bintang: pasangan kiri menang", pattern: "***", expectedSource: "^.*[^/]*$" },
    { case: "tanda tanya satu karakter", pattern: "feat/x?", expectedSource: "^feat\\/x[^/]$" },
    { case: "tanda tanya polos", pattern: "?", expectedSource: "^[^/]$" },
  ] satisfies GlobToRegExpCase[])("$case", ({ pattern, expectedSource }) => {
    expect(globToRegExp(pattern).source).toBe(expectedSource);
  });
});

type GlobMatchesCase = {
  case: string;
  pattern: string;
  value: string;
  expected: boolean;
};

describe("globMatches", () => {
  // lewati: pattern/karakter di luar alfabet & value/karakter di luar alfabet — alfabet tak terbatas; glob.ts:13: "Everything else is a literal"
  // lewati: pattern/panjang & value/panjang — tidak ada batas panjang di glob.ts:22-42 (loop i < pattern.length)
  it.each([
    { case: "pola kosong cocok dengan nilai kosong", pattern: "", value: "", expected: true },
    { case: "pola kosong menolak nilai non-kosong", pattern: "", value: "main", expected: false },
    { case: "nilai kosong menolak pola non-kosong", pattern: "main", value: "", expected: false },
    { case: "whitespace di pola adalah literal", pattern: "a b", value: "a b", expected: true },
    { case: "whitespace di nilai adalah literal", pattern: "a b", value: "a  b", expected: false },
    { case: "pencocokan peka huruf besar-kecil", pattern: "Main", value: "main", expected: false },
    { case: "literal cocok penuh", pattern: "main", value: "main", expected: true },
    { case: "nilai lebih panjang di awal", pattern: "main", value: "feature/main", expected: false },
    { case: "nilai lebih panjang di akhir", pattern: "main", value: "maintenance", expected: false },
    { case: "nilai lebih panjang di kedua ujung", pattern: "main", value: "xmainx", expected: false },
    { case: "bintang cocok dalam satu segmen", pattern: "feat/*", value: "feat/alpha", expected: true },
    { case: "bintang cocok nol karakter", pattern: "feat/*", value: "feat/", expected: true },
    { case: "bintang menolak garis miring", pattern: "feat/*", value: "feat/alpha/beta", expected: false },
    { case: "bintang dengan ekstensi", pattern: "*.yaml", value: "pipeline.yaml", expected: true },
    { case: "ekstensi lain ditolak", pattern: "*.yaml", value: "pipeline.yml", expected: false },
    { case: "dua bintang cocok kosong", pattern: "docs/**", value: "docs/", expected: true },
    { case: "dua bintang lintas segmen", pattern: "docs/**", value: "docs/a/b.txt", expected: true },
    { case: "dua bintang menolak awalan yang salah", pattern: "docs/**", value: "src/docs/a.md", expected: false },
    { case: "dua bintang di awal pola", pattern: "**/*.yaml", value: "a/b/c.yaml", expected: true },
    { case: "tanda tanya cocok satu karakter", pattern: "feat/x?", value: "feat/x1", expected: true },
    { case: "tanda tanya menolak dua karakter", pattern: "feat/x?", value: "feat/x12", expected: false },
    { case: "tanda tanya menolak garis miring", pattern: "feat/x?", value: "feat/x/", expected: false },
    { case: "titik di pola adalah titik literal", pattern: "a.b", value: "a.b", expected: true },
    { case: "titik pola tidak cocok karakter lain", pattern: "a.b", value: "aXb", expected: false },
    { case: "kurung di pola adalah literal", pattern: "(hotfix)", value: "(hotfix)", expected: true },
  ] satisfies GlobMatchesCase[])("$case", ({ pattern, value, expected }) => {
    expect(globMatches(pattern, value)).toBe(expected);
  });
});

type AnyGlobMatchesCase = {
  case: string;
  patterns: string[];
  value: string;
  expected: boolean;
};

describe("anyGlobMatches", () => {
  // lewati: value/* — semua sumbu string value sudah dicakup tabel globMatches; anyGlobMatches hanya meneruskannya (glob.ts:51)
  it.each([
    { case: "daftar pola kosong selalu false", patterns: [], value: "main", expected: false },
    { case: "satu pola cocok", patterns: ["main"], value: "main", expected: true },
    { case: "satu pola tidak cocok", patterns: ["main"], value: "release", expected: false },
    { case: "salah satu dari banyak pola cocok", patterns: ["main", "feat/**"], value: "feat/ui", expected: true },
    { case: "tidak ada yang cocok", patterns: ["main", "feat/**"], value: "release", expected: false },
    { case: "pola duplikat tidak mengubah hasil", patterns: ["main", "main"], value: "main", expected: true },
    { case: "elemen kosong cocok dengan nilai kosong", patterns: [""], value: "", expected: true },
    { case: "elemen kosong di tengah daftar", patterns: ["main", ""], value: "", expected: true },
  ] satisfies AnyGlobMatchesCase[])("$case", ({ patterns, value, expected }) => {
    expect(anyGlobMatches(patterns, value)).toBe(expected);
  });
});
