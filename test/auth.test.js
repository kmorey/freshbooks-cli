import test from "node:test";
import assert from "node:assert/strict";
import { authorizationUrl, exchangeAuthorizationCode, extractAuthorizationCode } from "../src/auth.js";

const config = {
  clientId: "client-id",
  redirectUri: "https://localhost/freshbooks/callback",
  apiBase: "https://api.freshbooks.test",
  authBase: "https://auth.freshbooks.test",
};

test("authorizationUrl includes the documented authorization-code parameters", () => {
  const result = authorizationUrl(config, "known-state");
  const url = new URL(result.url);
  assert.equal(url.origin, "https://auth.freshbooks.test");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.get("state"), "known-state");
});

test("extractAuthorizationCode accepts the failed localhost redirect copied from the browser", () => {
  assert.equal(
    extractAuthorizationCode("https://localhost/freshbooks/callback?code=abc123&state=s"),
    "abc123",
  );
});

test("exchangeAuthorizationCode normalizes token expiry", async () => {
  let request;
  const fetcher = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(
      JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        created_at: 1_788_271_200,
        expires_in: 43_200,
        scope: "user:time_entries:read user:time_entries:write",
      }),
      { status: 200 },
    );
  };
  const tokens = await exchangeAuthorizationCode({
    config,
    secrets: { clientSecret: "secret" },
    code: "abc123",
    fetcher,
  });
  assert.equal(request.url, "https://api.freshbooks.test/auth/oauth/token");
  assert.equal(request.body.grant_type, "authorization_code");
  assert.equal(tokens.accessToken, "access");
  assert.equal(tokens.refreshToken, "refresh");
  assert.equal(tokens.expiresAt, "2026-09-02T02:00:00.000Z");
});
