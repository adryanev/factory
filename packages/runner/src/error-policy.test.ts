/**
 * AC9: "Hanya `401` yang membuat Runner berhenti; `426`/`409`/`400`/`413`/
 * `429`/`503`/`5xx` semuanya membiarkan ia tetap heartbeat dan kembali ke
 * `/claim`." Every status the spec's error table names, exercised
 * individually — not just "401 stops, everything else is lumped together" —
 * so a future edit that special-cases one of them can't slip past a test
 * that never actually asked about it.
 */
import { describe, expect, it } from "vitest";
import { decideOnStatus, type RunnerAction } from "./error-policy.js";

describe("decideOnStatus", () => {
  // lewati: negatif — tidak ada batas terdokumentasi untuk status negatif di spec
  type DecideOnStatusCase = {
    case: string;
    status: number;
    expected: RunnerAction;
  };

  it.each([
    { case: "nol — tidak bernama di spec", status: 0, expected: "continue" },
    { case: "400 — payload ditolak, fatal bagi giliran", status: 400, expected: "continue" },
    { case: "401 — secret salah atau dicabut, satu-satunya yang mematikan", status: 401, expected: "stop" },
    { case: "402 — satu di atas 401, tidak bernama di spec", status: 402, expected: "continue" },
    { case: "409 — sewa bukan lagi miliknya, kembali ke /claim", status: 409, expected: "continue" },
    { case: "413 — melewati batas ukuran", status: 413, expected: "continue" },
    { case: "422 — payload ditolak", status: 422, expected: "continue" },
    { case: "426 — protokol di luar jangkauan, slow-poll", status: 426, expected: "continue" },
    { case: "429 — kelebihan beban, backoff", status: 429, expected: "continue" },
    { case: "500 — 5xx lain yang tidak dikenal", status: 500, expected: "continue" },
    { case: "502 — 5xx lain yang tidak dikenal", status: 502, expected: "continue" },
    { case: "503 — restarting, backoff", status: 503, expected: "continue" },
    { case: "504 — 5xx lain yang tidak dikenal", status: 504, expected: "continue" },
    { case: "200 — sukses 2xx ikut melanjutkan", status: 200, expected: "continue" },
  ] satisfies DecideOnStatusCase[])("$case", ({ status, expected }) => {
    expect(decideOnStatus(status)).toBe(expected);
  });
});
