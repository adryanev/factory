/**
 * In-memory fake for `ObjectStore` (see `src/object-store.ts`). Deterministic
 * URLs so tests can assert the control plane hands out exactly the minted
 * list — and a tiny object map so a test can simulate the browser's end of
 * the round trip (PUT bytes to the minted URL, read them back from the GET
 * URL) without dialing out to Garage.
 */
import type { MintedUrl, ObjectStore } from "../../src/object-store.js";

export const FAKE_PRESIGNED_LIFETIME_MS = 5 * 60 * 1000;

export interface FakeObjectStore extends ObjectStore {
  /** blobKey -> bytes, filled by `putFromUrl` (the Runner/browser side of the seam). */
  objects: Map<string, string>;
  /** Every blobKey a PUT was minted for, in order. */
  mintedPuts: string[];
  /** Every blobKey a GET was minted for, in order. */
  mintedGets: string[];
  /** Every blobKey `deleteObject` removed, in order — the retention sweep's half of the seam. */
  deleted: string[];
  /** The Runner's half: PUTs bytes to the minted URL. */
  putFromUrl(url: string, body: string): void;
  /** The browser's half: GETs bytes back from the minted URL. */
  getFromUrl(url: string): string | undefined;
}

function keyFromUrl(url: string): string {
  const parsed = new URL(url);
  const key = parsed.searchParams.get("key");
  if (!key) {
    throw new Error(`fake object store: minted URL is missing its key: ${url}`);
  }
  return key;
}

function mint(base: string, key: string, now: Date): MintedUrl {
  return {
    url: `${base}?key=${encodeURIComponent(key)}&sig=fake`,
    expiresAt: new Date(now.getTime() + FAKE_PRESIGNED_LIFETIME_MS),
  };
}

export function createFakeObjectStore(now: () => Date = () => new Date("2026-01-01T00:00:00.000Z")): FakeObjectStore {
  const objects = new Map<string, string>();
  const mintedPuts: string[] = [];
  const mintedGets: string[] = [];
  const deleted: string[] = [];
  return {
    objects,
    mintedPuts,
    mintedGets,
    deleted,
    mintPutUrl: async (key) => {
      mintedPuts.push(key);
      return mint("https://blob.invalid/put", key, now());
    },
    mintGetUrl: async (key) => {
      mintedGets.push(key);
      return mint("https://blob.invalid/get", key, now());
    },
    deleteObject: async (key) => {
      deleted.push(key);
      objects.delete(key);
    },
    putFromUrl(url, body) {
      objects.set(keyFromUrl(url), body);
    },
    getFromUrl(url) {
      return objects.get(keyFromUrl(url));
    },
  };
}
