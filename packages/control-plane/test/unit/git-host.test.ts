/**
 * Unit tests for the GitHub App half of `GitHost` that needs no network: the
 * RS256 app JWT minted to authorize installation-token requests, and the
 * unconfigured-host guard. Behaviour that only needs a request to be *sent*
 * is covered by the fake in seam-1 instead.
 *
 * The exception is how a real GitHub response body is parsed: the seam-1 fake
 * returns domain values, so it can never catch a wrong assumption about the
 * JSON GitHub actually sends. Those cases stub `fetch` and assert on the shape.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubHost, retryAfterFrom, signGithubAppJwt } from "../../src/domain/git-host.js";

const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIBOQIBAAJBAJtdPR5Kg9ShHyMrqSLcDUvxtADqsSJ6zh2SPfoKKGkPeYhQw/z0
P6io2zg+iN4s7EE35pAOCHPb2Ej/UKTEescCAwEAAQJAM3xEgsNCyLXUMb2IQUsX
BPHGKv+bT8fOgjIyY6f2GEpKTyFESsKQc3V0BuQzMfJ6FWHOiuPDfkHPyLoyUwPa
8QIhAMwL1mAuiYd6Qu2xV9v6ts3kAGHBv/TvuZBKQWTMS2eFAiEAwuw0YRJBYNwH
Td+iZsBcumJzqMXil/u81n/EgoWs/NsCIDXNtUR9YPRhT76fcbxmusdFpLgiP7yV
bcfXXLD4kbWFAiBICf4Nxi5tesQkTrt5mCxtIge233OwUfRnng7lYjwdswIgDVKA
WsProLT8UtyUK4gvfBd1A+torBt67hKT2qpUIyo=
-----END RSA PRIVATE KEY-----`;

describe("signGithubAppJwt", () => {
  it("produces a three-part RS256 JWT carrying the app id and a ≤10-minute lifetime", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const jwt = signGithubAppJwt(123456, PRIVATE_KEY, now);

    const [headerB64, payloadB64, signature] = jwt.split(".");
    expect(signature).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf-8"));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf-8"));
    expect(payload.iss).toBe(123456);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600); // GitHub: JWT lifetime ≤ 10 minutes.
    expect(payload.exp - payload.iat).toBeGreaterThan(0);
  });

  it("the two mints of a turn get distinct lifetimes but the same issuer", () => {
    const jwt1 = signGithubAppJwt(7, PRIVATE_KEY, new Date("2026-01-01T00:00:00.000Z"));
    const jwt2 = signGithubAppJwt(7, PRIVATE_KEY, new Date("2026-01-01T00:00:30.000Z"));
    expect(jwt1).not.toBe(jwt2); // iat/exp differ by the 30s between the mints.
    const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf-8"));
    expect(decode(jwt1).iss).toBe(decode(jwt2).iss);
  });
});

describe("createGithubHost", () => {
  it("minting without App credentials fails with a clear error instead of dialing github.com", async () => {
    const host = createGithubHost(); // no config — the read-only half.
    await expect(host.mintInstallationToken({ owner: "acme", name: "backend" }, 42)).rejects.toThrow(
      "github app credentials not configured",
    );
  });
});

describe("createBranch", () => {
  const repo = { owner: "acme", name: "backend" };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cuts the branch at the sha the base ref points at", async () => {
    const baseSha = "a".repeat(40);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/main", object: { sha: baseSha } }))
      .mockResolvedValueOnce(Response.json({ ref: "refs/heads/factory/editor/e1" }, { status: 201 }));

    await createGithubHost().createBranch(repo, "factory/editor/e1", "main", "t");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/backend/git/ref/heads/main");
    const [createUrl, createInit] = fetchMock.mock.calls[1]!;
    expect(createUrl).toBe("https://api.github.com/repos/acme/backend/git/refs");
    expect(JSON.parse(String(createInit?.body))).toEqual({ ref: "refs/heads/factory/editor/e1", sha: baseSha });
  });

  it("treats a branch that already exists as success — the retried request meets its own branch", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ object: { sha: "b".repeat(40) } }))
      .mockResolvedValueOnce(Response.json({ message: "Reference already exists" }, { status: 422 }));

    await expect(createGithubHost().createBranch(repo, "factory/editor/e1", "main", "t")).resolves.toBeUndefined();
  });

  it("surfaces an unreadable base ref instead of cutting from nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 404 }));

    await expect(createGithubHost().createBranch(repo, "factory/editor/e1", "gone", "t")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("readFileSha", () => {
  const repo = { owner: "acme", name: "backend" };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the blob sha of the file on that ref", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ type: "file", sha: "c".repeat(40) }));

    await expect(createGithubHost().readFileSha(repo, ".factory/pipeline.yaml", "factory/editor/e1", "t")).resolves.toBe(
      "c".repeat(40),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/backend/contents/.factory/pipeline.yaml?ref=factory%2Feditor%2Fe1",
    );
  });

  it("reads a missing file as null — that is the new-file case, not a failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));

    await expect(
      createGithubHost().readFileSha(repo, ".factory/new.yaml", "factory/editor/e1", "t"),
    ).resolves.toBeNull();
  });

  it("surfaces any other failure instead of reporting the file absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }));

    await expect(
      createGithubHost().readFileSha(repo, ".factory/pipeline.yaml", "factory/editor/e1", "t"),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("writeFile", () => {
  const repo = { owner: "acme", name: "backend" };
  const input = {
    path: ".factory/pipeline.yaml",
    content: "steps: []",
    branch: "factory/editor/e1",
    message: "factory: update",
    author: { name: "someone", email: "someone@users.noreply.github.com" },
    committer: { name: "factory[bot]", email: "factory[bot]@users.noreply.github.com" },
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the sha of the file it replaces", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ commit: { sha: "d".repeat(40) } }));

    await createGithubHost().writeFile(repo, { ...input, sha: "e".repeat(40) }, "t");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).sha).toBe("e".repeat(40));
  });

  it("omits sha entirely for a new file — the Contents API rejects one for a path that holds nothing", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ commit: { sha: "d".repeat(40) } }));

    await createGithubHost().writeFile(repo, input, "t");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty("sha");
  });
});

describe("listRefsByPrefix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the matching-refs array GitHub sends and returns bare branch names", async () => {
    // Verified against the API on 2026-08-12 (issue #39): matching-refs
    // responds with a plain array, NOT an object wrapping a `refs` key.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        { ref: "refs/heads/run/abc/step-1", object: { sha: "1".repeat(40) } },
        { ref: "refs/heads/run/abc/step-2", object: { sha: "2".repeat(40) } },
      ]),
    );

    const branches = await createGithubHost().listRefsByPrefix({ owner: "acme", name: "backend" }, "run/abc", "t");

    expect(branches).toEqual(["run/abc/step-1", "run/abc/step-2"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/backend/git/matching-refs/heads/run/abc",
    );
  });

  it("returns no branches when the prefix matches nothing", async () => {
    // matching-refs answers 200 with an empty array, unlike git/ref's 404.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));

    await expect(
      createGithubHost().listRefsByPrefix({ owner: "acme", name: "backend" }, "run/gone", "t"),
    ).resolves.toEqual([]);
  });

  it("surfaces a failed listing as a retryable GithubRequestError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 503, headers: { "retry-after": "30" } }),
    );

    await expect(
      createGithubHost().listRefsByPrefix({ owner: "acme", name: "backend" }, "run/abc", "t"),
    ).rejects.toMatchObject({ status: 503, retryAfterSeconds: 30 });
  });
});

describe("retryAfterFrom", () => {
  it("returns the Retry-After seconds GitHub sent, verbatim", () => {
    const response = new Response(null, { headers: { "retry-after": "120" } });
    expect(retryAfterFrom(response)).toBe(120);
  });

  it("returns null when GitHub sent no Retry-After header", () => {
    const response = new Response(null, { status: 500 });
    expect(retryAfterFrom(response)).toBeNull();
  });

  it("returns null for a header that is not a positive number", () => {
    expect(retryAfterFrom(new Response(null, { headers: { "retry-after": "later" } }))).toBeNull();
    expect(retryAfterFrom(new Response(null, { headers: { "retry-after": "-3" } }))).toBeNull();
  });
});
