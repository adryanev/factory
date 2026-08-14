import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS, isArtifactKind, normalizeArtifactKey } from "./artifacts.js";

type NormalizeArtifactKeyCase = {
  case: string;
  input: string;
  expected: string;
};

describe("normalizeArtifactKey", () => {
  it.each([
    { case: "input kosong jatuh ke slug stabil", input: "", expected: "artifact" },
    { case: "hanya whitespace jatuh ke slug stabil", input: "   ", expected: "artifact" },
    { case: "huruf besar dilowercase-kan", input: "PRD", expected: "prd" },
    { case: "campur huruf dan spasi dinormalisasi", input: "laporan Final v2", expected: "laporan-final-v2" },
    { case: "spasi dikolaps jadi dash, titik dipertahankan", input: "My Report.md", expected: "my-report.md" },
    { case: "karakter di luar alfabet semuanya → slug stabil", input: "!!!", expected: "artifact" },
    { case: "sudah berbentuk slug diteruskan apa adanya", input: "diff", expected: "diff" },
    { case: "titik dan underscore dipertahankan sebagai separator", input: "plan.v2_final", expected: "plan.v2_final" },
    { case: "separator di awal dibuang", input: ".hidden", expected: "hidden" },
    { case: "separator berulang di akhir dibuang", input: "  leading dots..", expected: "leading-dots" },
    { case: "tepat di batas 64 karakter", input: "a".repeat(64), expected: "a".repeat(64) },
    { case: "satu karakter di atas batas 64", input: "a".repeat(65), expected: "a".repeat(64) },
    { case: "jauh di atas batas dipotong di 64", input: "a".repeat(120), expected: "a".repeat(64) },
  ] satisfies NormalizeArtifactKeyCase[])("$case", ({ input, expected }) => {
    expect(normalizeArtifactKey(input)).toBe(expected);
  });
});

describe("ARTIFACT_KINDS", () => {
  // Klaim universal atas himpunan milik kode produksi (klausa 7) — menabelkannya
  // menyalin daftar hidup ke dalam test; bertahan sebagai prosa.
  it("adalah himpunan tertutup enam kind yang wajib ditutup UI", () => {
    expect(ARTIFACT_KINDS).toEqual(["diff", "transcript", "document", "structured", "command-output", "binary"]);
  });

  type IsArtifactKindCase = {
    case: string;
    input: string;
    expected: boolean;
  };

  // lewati: kosong/hanya whitespace — ARTIFACT_KINDS di artifacts.ts:15-22 tidak memuat keduanya; satu baris nilai di luar himpunan mewakili sumbu
  // lewati: case — semua arm huruf kecil di artifacts.ts:15-22 dan includes() di artifacts.ts:27 peka case; varian case adalah nilai di luar himpunan
  // lewati: separator — ARTIFACT_KINDS di artifacts.ts:15-22 bukan format berseparator
  // lewati: panjang — tidak ada batas panjang di artifacts.ts
  it.each([
    { case: "diff", input: "diff", expected: true },
    { case: "transcript", input: "transcript", expected: true },
    { case: "document", input: "document", expected: true },
    { case: "structured", input: "structured", expected: true },
    { case: "command-output", input: "command-output", expected: true },
    { case: "binary", input: "binary", expected: true },
    { case: "nilai di luar himpunan tertutup", input: "video", expected: false },
  ] satisfies IsArtifactKindCase[])("$case", ({ input, expected }) => {
    expect(isArtifactKind(input)).toBe(expected);
  });
});
