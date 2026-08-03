import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";

describe("POST /scaffold-probes, GET /scaffold-probes/:id", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await startTestRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("writes a row with a client-generated id and reads it back through Postgres", async () => {
    const id = generateId("probe");

    const created = await rig.fetchWithCsrf(`${rig.baseUrl}/scaffold-probes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, message: "seam-1 rig proves the round trip" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      id,
      status: "ok",
      message: "seam-1 rig proves the round trip",
    });

    const fetched = await fetch(`${rig.baseUrl}/scaffold-probes/${id}`);
    expect(fetched.status).toBe(200);
    const fetchedBody = await fetched.json();
    expect(fetchedBody).toEqual(createdBody);
  });

  it("rejects a malformed id with { code, message } and 400, without writing a row", async () => {
    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/scaffold-probes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "not-a-valid-id", message: "should be rejected" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ code: "invalid_id", message: expect.any(String) });
  });

  it("returns 404 with { code, message } for an id that was never written", async () => {
    const response = await fetch(`${rig.baseUrl}/scaffold-probes/${generateId("probe")}`);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ code: "not_found", message: expect.any(String) });
  });
});
