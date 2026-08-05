/**
 * The object-store seam (Garage, an S3-compatible engine): the only place a
 * presigned URL is minted, and the reason byte traffic never touches the
 * control plane. The control plane owns the Garage credentials (deps) and
 * hands out short-lived presigned PUTs to the Runner and presigned GETs to
 * the browser; every byte moves directly between those peers and Garage
 * (spec: "Byte tidak pernah lewat control plane").
 *
 * One real implementation (`createS3ObjectStore`) — hand-rolled AWS SigV4
 * presigning over `node:crypto`, exactly the way `git-host.ts` hand-rolls the
 * GitHub App JWT — and one fake for tests (`test/seam1/fake-object-store.ts`).
 * Minting is pure crypto with no outbound call, so a test that injects the
 * fake and a contract test that runs the real thing against a live Garage
 * (test/garage/garage-contract.test.ts) exercise the same interface.
 *
 * Presigned URLs live 5 minutes, stated, not shortened (spec: "Presigned 5
 * menit dinyatakan, tidak diperpendek"). Revoking a person's access applies
 * instantly to everything they ask for *next*; already-minted URLs stay
 * valid until expiry — revocation is not recall. Both properties are
 * documented in docs/adr.
 */
import { createHash, createHmac } from "node:crypto";

/** A minted URL plus the exact instant it stops being valid — the caller's expiry, not the credential's. */
export interface MintedUrl {
  url: string;
  expiresAt: Date;
}

export interface ObjectStore {
  /** A presigned PUT for the Runner to upload `key` straight to the bucket. */
  mintPutUrl(key: string): Promise<MintedUrl>;
  /** A presigned GET for the browser to read `key` straight from the bucket. */
  mintGetUrl(key: string): Promise<MintedUrl>;
  /**
   * Deletes `key` from the bucket — the retention sweep's half of the seam
   * (spec: "aplikasi menghapus objek Garage ... di luar transaksi SQL ini").
   * A DELETE carries no object bytes, so this is not a byte path: the
   * control plane signs and issues the request itself, and never proxies
   * a payload either way. Idempotent: a key that is already gone is not an
   * error (S3 answers 204/404 either way).
   */
  deleteObject(key: string): Promise<void>;
}

export interface S3ObjectStoreConfig {
  /** e.g. `http://garage:3900` — the S3 API endpoint, never the admin/RPC port. */
  endpoint: string;
  /** The bucket's region as Garage reports it (`garage` in deploy/garage/garage.toml). */
  region: string;
  /** The default bucket, created by Garage's `--default-bucket` flag. */
  bucket: string;
  /** The default access key created by `--default-access-key` (env, per deploy split). */
  accessKey: string;
  /** The matching secret key — never logged, never leaves the process. */
  secretKey: string;
}

/** 5 minutes (spec: "Presigned 5 menit dinyatakan, tidak diperpendek"). S3's per-signature ceiling is 7 days; this is far under it. */
export const PRESIGNED_URL_LIFETIME_SECONDS = 300;

const SERVICE = "s3";

const hex = (bytes: Buffer): string => bytes.toString("hex");
const sha256 = (data: string): Buffer => createHash("sha256").update(data, "utf8").digest();
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 percent-encoding, the variant AWS SigV4 expects: `encodeURIComponent` plus the `! ' ( ) *` sub-delims. */
function canonicalEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDateFormat(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Builds a SigV4-presigned URL for one object. Path-style addressing
 * (`/bucket/key`), host-only signed headers, `UNSIGNED-PAYLOAD` — the exact
 * shape the S3 API accepts for presigned PUT/GET and the shape Garage's S3
 * layer understands (verified hands-on against v2.3.0, see recon-deps.md).
 */
function presign(config: S3ObjectStoreConfig, method: "PUT" | "GET" | "DELETE", key: string, now: Date): MintedUrl {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const host = new URL(endpoint).host;
  const canonicalUri = `/${config.bucket}/${key.split("/").map(canonicalEncode).join("/")}`;

  const amzDate = amzDateFormat(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;

  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKey}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(PRESIGNED_URL_LIFETIME_SECONDS),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${canonicalEncode(name)}=${canonicalEncode(value)}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\nhost\nUNSIGNED-PAYLOAD`;

  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hex(sha256(canonicalRequest))}`;

  const kDate = hmac(`AWS4${config.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hex(hmac(kSigning, stringToSign));

  return {
    url: `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + PRESIGNED_URL_LIFETIME_SECONDS * 1000),
  };
}

export function createS3ObjectStore(config: S3ObjectStoreConfig, now: () => Date = () => new Date()): ObjectStore {
  return {
    mintPutUrl: (key) => Promise.resolve(presign(config, "PUT", key, now())),
    mintGetUrl: (key) => Promise.resolve(presign(config, "GET", key, now())),
    deleteObject: async (key) => {
      const minted = presign(config, "DELETE", key, now());
      const response = await fetch(minted.url, { method: "DELETE" });
      // 404 = the object was already reclaimed — deleting twice is fine.
      if (!response.ok && response.status !== 404) {
        throw new Error(`garage delete failed: ${response.status}`);
      }
    },
  };
}
