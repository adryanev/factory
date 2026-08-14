/**
 * The webhook-delivery sweep's retry schedule: 30s, doubling per failed
 * attempt, capped at an hour. The selection and dead-letter behaviour that
 * consumes this schedule is proven end-to-end in test/seam1/automation.test.ts;
 * this pins the one decision that is pure — how long to wait before the next
 * attempt — so it can be checked without a database or a clock.
 */
import { describe, expect, it } from "vitest";
import { webhookRetryBackoffMs } from "../../src/domain/automation/index.js";

type WebhookRetryBackoffCase = {
  case: string;
  attempts: number;
  expected: number;
};

describe("webhookRetryBackoffMs", () => {
  // lewati: negatif — attempts menghitung percobaan gagal sejak 0 (webhooks.ts:54) dan pemanggil menaikkan ke >= 1 sebelum memanggil (delivery-sweep.ts:75); docstring delivery-sweep.ts:22-24 mendokumentasikan domain mulai dari attempts=1
  it.each([
    {
      case: "nol attempt — satu di bawah start, setengah base",
      attempts: 0,
      expected: 15_000,
    },
    {
      case: "attempt 1 = start — 30 detik",
      attempts: 1,
      expected: 30_000,
    },
    {
      case: "attempt 2 — menggandakan jadi 60 detik",
      attempts: 2,
      expected: 60_000,
    },
    {
      case: "attempt 3 — menggandakan jadi 120 detik",
      attempts: 3,
      expected: 120_000,
    },
    {
      case: "attempt 4 — menggandakan jadi 240 detik",
      attempts: 4,
      expected: 240_000,
    },
    {
      case: "attempt 7 — satu di bawah cap, belum dipotong",
      attempts: 7,
      expected: 1_920_000,
    },
    {
      case: "attempt 8 — tepat di cap: 30_000 * 2^7 melewati 1 jam",
      attempts: 8,
      expected: 3_600_000,
    },
    {
      case: "attempt 9 — satu di atas cap, tetap 1 jam",
      attempts: 9,
      expected: 3_600_000,
    },
    {
      case: "attempt 20 — jauh di atas cap, tetap 1 jam",
      attempts: 20,
      expected: 3_600_000,
    },
  ] satisfies WebhookRetryBackoffCase[])("$case", ({ attempts, expected }) => {
    expect(webhookRetryBackoffMs(attempts)).toBe(expected);
  });
});
