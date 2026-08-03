/**
 * Narrow interface, one real implementation — the same shape `GitHost` will
 * take in issue #6. GitHub identity answers "who are you" only; nothing
 * here is ever consulted for "what may you do" (spec: "Identitas GitHub
 * hanya untuk otentikasi, tidak pernah untuk otorisasi"). Tests inject a
 * fake so seam-1 never dials out to github.com.
 */
export interface GithubIdentity {
  githubUserId: number;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GithubOAuthClient {
  /** The URL to send the browser to. `state` is opaque — the caller is responsible for verifying it round-trips on callback. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchanges a one-time `code` for the identity of the GitHub user who authorized the app. Throws on any failure — an invalid/expired code included. */
  exchangeCode(code: string, redirectUri: string): Promise<GithubIdentity>;
}

interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

interface GithubAccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

/** Real implementation: two calls over `fetch` (Node 20's global, no HTTP client dependency), authorization code -> access token -> user profile. */
export function createGithubOAuthClient(config: GithubOAuthConfig): GithubOAuthClient {
  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "read:user read:org");
      return url.toString();
    },

    async exchangeCode(code, redirectUri) {
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const tokenBody = (await tokenResponse.json()) as GithubAccessTokenResponse;
      if (!tokenResponse.ok || !tokenBody.access_token) {
        throw new Error(
          `github oauth code exchange failed: ${tokenBody.error ?? tokenResponse.status} ${tokenBody.error_description ?? ""}`.trim(),
        );
      }

      const userResponse = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: "application/vnd.github+json",
        },
      });
      if (!userResponse.ok) {
        throw new Error(`github user lookup failed: ${userResponse.status}`);
      }
      const user = (await userResponse.json()) as GithubUserResponse;

      return {
        githubUserId: user.id,
        githubLogin: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
      };
    },
  };
}
