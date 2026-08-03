import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorResponseSchema } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";

describe("GET /health, GET /ready", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await startTestRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("reports the injected clock, not the wall clock", async () => {
    rig.setClock(new Date("2030-05-17T12:00:00.000Z"));

    const response = await fetch(`${rig.baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", time: "2030-05-17T12:00:00.000Z" });
  });

  it("confirms Postgres is reachable through the migrated schema", async () => {
    const response = await fetch(`${rig.baseUrl}/ready`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ready" });
  });

  it("returns the { code, message } shape for unknown routes", async () => {
    const response = await fetch(`${rig.baseUrl}/does-not-exist`);
    const body: unknown = await response.json();

    expect(response.status).toBe(404);
    expect(errorResponseSchema.safeParse(body).success).toBe(true);
  });
});
