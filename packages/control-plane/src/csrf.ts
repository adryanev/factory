/**
 * The one header every mutating request must send (spec: "CSRF ditutup
 * SameSite=Lax + kewajiban header non-sederhana yang memicu preflight —
 * nol token, nol tabel"). Exported so `app.ts`'s check and every caller
 * (the web app, and every seam-1 test firing a real mutating request) share
 * one definition instead of two copies of the string that can drift.
 */
export const CSRF_HEADER_NAME = "x-factory-csrf";
export const CSRF_HEADER_VALUE = "1";
