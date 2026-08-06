/**
 * Real-Garage contract test (issue #7): the hand-rolled SigV4 presigner in
 * `src/object-store.ts` against a live `dxflrs/garage:v2.3.0`, the exact
 * pinned version and the same `--single-node --default-bucket
 * --default-access-key` invocation `compose.yaml` ships (the pin is
 * load-bearing: pre-2.3.0 Garage fails on the first upload, not at boot —
 * see recon-deps.md). Proves the whole peer-to-peer path the spec names:
 *
 *   presigned PUT  → bytes land in the bucket
 *   presigned GET  → the same bytes come back
 *
 * with zero involvement from any control-plane byte path. Bucket CORS (GET
 * for browser, PUT for Runner) is a deploy-level property proven in
 * recon-deps.md against this same image and applied by
 * deploy/garage/configure-cors.sh, so it is not re-proven here.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import { createS3ObjectStore, type S3ObjectStoreConfig } from "../../src/object-store.js";

const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";
const ACCESS_KEY = "contract-access-key";
const SECRET_KEY = "contract-secret-key";
// 32 bytes of hex — Garage's RPC secret requirement (compose's .env supplies
// the same shape).
const RPC_SECRET = "0000000000000000000000000000000000000000000000000000000000000000";

describe("Garage contract: presigned PUT/GET round trip", () => {
  let endpoint: string;
  let store: ReturnType<typeof createS3ObjectStore>;
  let configDir: string;

  beforeAll(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "factory-garage-"));
    // metadata/data dirs must be writable by the image's user — /tmp is.
    const toml = [
      'metadata_dir = "/tmp/garage-meta"',
      'data_dir = "/tmp/garage-data"',
      'db_engine = "sqlite"',
      "replication_factor = 1",
      'rpc_bind_addr = "[::]:3901"',
      'rpc_public_addr = "127.0.0.1:3901"',
      '[s3_api]',
      's3_region = "garage"',
      'api_bind_addr = "[::]:3900"',
      'root_domain = ".s3.garage.localhost"',
      "[admin]",
      'api_bind_addr = "[::]:3903"',
      "",
    ].join("\n");
    await writeFile(path.join(configDir, "garage.toml"), toml);

    const container = await new GenericContainer(GARAGE_IMAGE)
      .withCommand(["/garage", "server", "--single-node", "--default-bucket", "--default-access-key"])
      .withEnvironment({
        GARAGE_RPC_SECRET: RPC_SECRET,
        GARAGE_DEFAULT_BUCKET: "factory",
        GARAGE_DEFAULT_ACCESS_KEY: ACCESS_KEY,
        GARAGE_DEFAULT_SECRET_KEY: SECRET_KEY,
      })
      .withCopyContentToContainer([{ content: toml, target: "/etc/garage.toml" }])
      .withTmpFs({ "/tmp": "rw" })
      .withExposedPorts(3900)
      .withWaitStrategy(Wait.forLogMessage(/S3 API server listening/))
      .start();

    endpoint = `http://127.0.0.1:${container.getMappedPort(3900)}`;
    const config: S3ObjectStoreConfig = {
      endpoint,
      region: "garage",
      bucket: "factory",
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
    };
    store = createS3ObjectStore(config);
  });

  afterAll(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("presigned PUT uploads bytes and presigned GET reads exactly them back", async () => {
    const key = `log/steprun_contract_1/1/0`;
    const payload = "hello from the garage contract test\n";

    const put = await store.mintPutUrl(key);
    const putResponse = await fetch(put.url, { method: "PUT", body: payload });
    expect(putResponse.status).toBe(200);

    const get = await store.mintGetUrl(key);
    const getResponse = await fetch(get.url);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe(payload);
  });

  it("mints URLs that expire exactly 5 minutes out (stated, not shortened)", async () => {
    const { expiresAt } = await store.mintGetUrl("log/steprun_contract_1/1/0");
    const ttlSeconds = Math.round((expiresAt.getTime() - Date.now()) / 1000);
    expect(ttlSeconds).toBeGreaterThanOrEqual(300 - 5);
    expect(ttlSeconds).toBeLessThanOrEqual(300);
  });

  it("deleteObject reclaims the object the presigned PUT uploaded", async () => {
    const key = `artifact/steprun_contract_2/a1`;
    const payload = "bytes that must stop existing\n";

    const put = await store.mintPutUrl(key);
    const putResponse = await fetch(put.url, { method: "PUT", body: payload });
    expect(putResponse.status).toBe(200);

    await store.deleteObject(key);

    const get = await store.mintGetUrl(key);
    const getResponse = await fetch(get.url);
    expect(getResponse.status).toBe(404);
  });

  it("deleteObject of a key that is already gone is not an error (idempotent)", async () => {
    await expect(store.deleteObject("artifact/steprun_contract_2/never-existed")).resolves.toBeUndefined();
  });
});
