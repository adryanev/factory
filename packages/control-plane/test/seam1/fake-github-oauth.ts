/**
 * Fake implementation of `GithubOAuthClient` (src/domain/github-identity.ts)
 * for seam-1: no test ever dials out to github.com. A test registers what
 * identity a one-time code exchanges for, then drives the real
 * `/auth/github/login` -> `/auth/github/callback` HTTP endpoints exactly
 * like a browser would.
 */
import type { GithubIdentity, GithubOAuthClient } from "../../src/domain/github-identity.js";

export interface FakeGithubOAuthClient extends GithubOAuthClient {
  registerCode(code: string, identity: GithubIdentity): void;
}

export function createFakeGithubOAuthClient(): FakeGithubOAuthClient {
  const codes = new Map<string, GithubIdentity>();
  return {
    registerCode(code, identity) {
      codes.set(code, identity);
    },
    authorizeUrl(state, redirectUri) {
      return `https://github.example/fake-authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    },
    async exchangeCode(code) {
      const identity = codes.get(code);
      if (!identity) {
        throw new Error(`fake github oauth: unregistered code ${code}`);
      }
      return identity;
    },
  };
}
