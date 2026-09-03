import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FreshBooksClient } from "../src/api.js";

test("an unauthorized API call rotates the one-time refresh token and retries once", async () => {
  const requests = [];
  let secrets = {
    clientSecret: "client-secret",
    accessToken: "stale-access",
    refreshToken: "old-refresh",
    expiresAt: "2026-09-02T00:00:00Z",
  };
  const config = {
    clientId: "client-id",
    redirectUri: "https://localhost/callback",
    apiBase: "https://api.freshbooks.test",
    profile: "default",
  };
  const configStore = {
    paths: { refreshLock: join(tmpdir(), `freshbooks-cli-test-${process.pid}-${Date.now()}.lock`) },
    async read() { return config; },
  };
  const secretStore = {
    async read() { return { ...secrets }; },
    async write(_profile, next) { secrets = { ...next }; },
  };
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/auth/oauth/token")) {
      assert.equal(JSON.parse(options.body).refresh_token, "old-refresh");
      return Response.json({
        access_token: "fresh-access",
        refresh_token: "new-refresh",
        created_at: 1_788_271_200,
        expires_in: 43_200,
      });
    }
    if (options.headers.Authorization === "Bearer stale-access") {
      return Response.json({ message: "expired" }, { status: 401 });
    }
    assert.equal(options.headers.Authorization, "Bearer fresh-access");
    return Response.json({ time_entries: [] });
  };

  const client = new FreshBooksClient({
    configStore,
    secretStore,
    fetcher,
    now: () => new Date("2026-09-01T12:00:00Z"),
  });
  assert.deepEqual(await client.request("/timetracking/business/123/time_entries"), {
    time_entries: [],
  });
  assert.equal(secrets.refreshToken, "new-refresh");
  assert.equal(requests.length, 3);
});

test("a timed-out mutation reports an ambiguous outcome", async () => {
  const configStore = {
    async read() { return { apiBase: "https://api.freshbooks.test", profile: "default" }; },
  };
  const secretStore = { async read() { return { accessToken: "test", expiresAt: "2099-01-01T00:00:00Z" }; } };
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const client = new FreshBooksClient({
    configStore,
    secretStore,
    fetcher: async () => { throw timeout; },
  });
  await assert.rejects(
    client.request("/timetracking/business/123/time_entries/9", { method: "PUT", body: {} }),
    { code: "API_TIMEOUT", outcomeUnknown: true },
  );
});

test("a mutation transport failure reports an ambiguous outcome", async () => {
  const configStore = { async read() { return { apiBase: "https://api.freshbooks.test", profile: "default" }; } };
  const secretStore = { async read() { return { accessToken: "test", expiresAt: "2099-01-01T00:00:00Z" }; } };
  const client = new FreshBooksClient({
    configStore,
    secretStore,
    fetcher: async () => { throw new TypeError("connection reset"); },
  });
  await assert.rejects(
    client.request("/timetracking/business/123/time_entries/9", { method: "DELETE" }),
    { code: "API_TRANSPORT", outcomeUnknown: true },
  );
});
