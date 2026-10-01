import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMAND_BUDGETS_MS, FreshBooksClient } from "../src/api.js";

test("exports operation budgets for bounded request workflows", () => {
  assert.deepEqual(COMMAND_BUDGETS_MS, {
    read: 64_000,
    singleWrite: 128_000,
    multiSegment: 320_000,
    log: 192_000,
    switch: 320_000,
  });
});

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

test("rate retries and one auth replay share one bounded request deadline", async () => {
  const requests = [];
  const waits = [];
  let dataAttempts = 0;
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
    profile: "bounded",
  };
  const configStore = {
    paths: { refreshLock: join(tmpdir(), `freshbooks-cli-bounded-${process.pid}-${Date.now()}.lock`) },
    async read() { return config; },
  };
  const secretStore = {
    async read() { return { ...secrets }; },
    async write(_profile, next) { secrets = { ...next }; },
  };
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), signal: options.signal });
    if (String(url).endsWith("/auth/oauth/token")) {
      return Response.json({
        access_token: "fresh-access",
        refresh_token: "new-refresh",
        created_at: 1_788_271_200,
        expires_in: 43_200,
      });
    }
    dataAttempts += 1;
    if (dataAttempts <= 3) {
      return Response.json({ message: "slow down" }, {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    if (dataAttempts === 4) return Response.json({ message: "expired" }, { status: 401 });
    assert.equal(options.headers.Authorization, "Bearer fresh-access");
    return Response.json({ time_entries: [] });
  };
  const client = new FreshBooksClient({
    configStore,
    secretStore,
    fetcher,
    sleeper: async (milliseconds, _value, { signal }) => {
      assert.equal(signal.aborted, false);
      waits.push(milliseconds);
    },
    now: () => new Date("2026-09-01T12:00:00Z"),
  });

  assert.deepEqual(await client.request("/timetracking/business/123/time_entries"), {
    time_entries: [],
  });
  assert.deepEqual(waits, [1_000, 1_000, 1_000]);
  assert.equal(dataAttempts, 5);
  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ signal }) => signal instanceof AbortSignal));
  assert.equal(secrets.refreshToken, "new-refresh");
});

test("combined retries expire at one deterministic absolute boundary", async () => {
  let elapsedMs = 0;
  let dataAttempts = 0;
  let refreshes = 0;
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
    profile: "deadline",
  };
  const configStore = {
    paths: { refreshLock: join(tmpdir(), `freshbooks-cli-deadline-${process.pid}-${Date.now()}.lock`) },
    async read() { return config; },
  };
  const secretStore = {
    async read() { return { ...secrets }; },
    async write(_profile, next) { secrets = { ...next }; },
  };
  const response = (status, payload, { bodyCostMs = 0, headers } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      elapsedMs += bodyCostMs;
      return JSON.stringify(payload);
    },
  });
  const client = new FreshBooksClient({
    configStore,
    secretStore,
    requestBudgetMs: 2_000,
    clock: () => elapsedMs,
    sleeper: async (milliseconds) => { elapsedMs += milliseconds; },
    now: () => new Date("2026-09-01T12:00:00Z"),
    fetcher: async (url) => {
      if (String(url).endsWith("/auth/oauth/token")) {
        refreshes += 1;
        return response(200, {
          access_token: "fresh-access",
          refresh_token: "new-refresh",
          created_at: 1_788_271_200,
          expires_in: 43_200,
        }, { bodyCostMs: 400 });
      }
      dataAttempts += 1;
      if (dataAttempts === 1) {
        return response(429, { message: "slow down" }, {
          headers: { "retry-after": "1" },
        });
      }
      if (dataAttempts === 2) return response(401, { message: "expired" });
      return response(200, { time_entries: [] }, { bodyCostMs: 600 });
    },
  });

  await assert.rejects(
    client.request("/timetracking/business/123/time_entries"),
    { code: "API_TIMEOUT", outcomeUnknown: false },
  );
  assert.equal(elapsedMs, 2_000);
  assert.equal(dataAttempts, 3);
  assert.equal(refreshes, 1);
  assert.equal(secrets.refreshToken, "new-refresh");
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
