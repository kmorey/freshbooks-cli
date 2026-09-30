import test from "node:test";
import assert from "node:assert/strict";
import { Output } from "../src/output.js";
import { CliError } from "../src/errors.js";
import { run } from "../src/cli.js";
import { canonicalTimeEntry } from "../src/tracking.js";

function sink() {
  return { value: "", write(chunk) { this.value += chunk; } };
}

test("JSON output is a stable one-object envelope", () => {
  const stdout = sink();
  const stderr = sink();
  const output = new Output({ json: true, stdout, stderr });
  output.success({ active: false, timers: [] });
  assert.deepEqual(JSON.parse(stdout.value), { schemaVersion: 1, ok: true, data: { active: false, timers: [] } });
  assert.equal(stderr.value, "");
});

test("JSON errors carry a machine-readable code", () => {
  const stdout = sink();
  const stderr = sink();
  const output = new Output({ json: true, stdout, stderr });
  assert.equal(output.error(new CliError("Login required", { code: "AUTH_REQUIRED", exitCode: 4 })), 4);
  assert.deepEqual(JSON.parse(stderr.value), {
    schemaVersion: 1,
    ok: false,
    error: { code: "AUTH_REQUIRED", message: "Login required" },
  });
});

test("JSON output preserves all guard rejection detail fields", () => {
  const stdout = sink();
  const stderr = sink();
  const output = new Output({ json: true, stdout, stderr });
  const current = {
    contractVersion: 2,
    kind: "time-entry",
    id: "9",
    exists: false,
    token: null,
  };
  const details = {
    contractVersion: 2,
    identity: { kind: "time-entry", id: "9" },
    expectedToken: "stale",
    currentToken: null,
    current,
  };

  output.error(new CliError("The FreshBooks record changed since it was loaded", {
    code: "GUARD_REJECTED",
    details,
  }));

  assert.deepEqual(JSON.parse(stderr.value), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "GUARD_REJECTED",
      message: "The FreshBooks record changed since it was loaded",
      details,
    },
  });
  assert.equal(stdout.value, "");
});

test("timer guard requires an explicit canonical identity before reading", async () => {
  const stdout = sink();
  const stderr = sink();
  let reads = 0;
  const configStore = { async read() {
    reads += 1;
    return { businessId: 123, timezone: "America/Chicago" };
  } };

  assert.equal(await run(["timer", "pause", "--guard", "stale", "--json"], {
    stdout,
    stderr,
    configStore,
    client: { async request() { throw new Error("Timer API must not be read"); } },
  }), 2);
  assert.deepEqual(JSON.parse(stderr.value), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message: "Guarded timer mutations require --id",
    },
  });
  assert.equal(reads, 0);
});

test("disappeared guarded timer returns canonical deleted details without writing", async () => {
  const stdout = sink();
  const stderr = sink();
  let writes = 0;
  const configStore = { async read() {
    return { businessId: 123, timezone: "America/Chicago" };
  } };
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: [] };
    if (options.method) writes += 1;
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };

  assert.equal(await run([
    "timer", "pause", "--id", "901", "--guard", "stale", "--json",
  ], {
    stdout,
    stderr,
    configStore,
    client,
    now: () => new Date("2026-09-01T15:00:00Z"),
  }), 1);
  assert.deepEqual(JSON.parse(stderr.value), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "GUARD_REJECTED",
      message: "The FreshBooks record changed since it was loaded",
      details: {
        contractVersion: 2,
        identity: { kind: "active-timer", id: "901" },
        expectedToken: "stale",
        currentToken: null,
        current: {
          contractVersion: 2,
          kind: "active-timer",
          id: "901",
          exists: false,
          token: null,
        },
      },
    },
  });
  assert.equal(writes, 0);
  assert.equal(stdout.value, "");
});

test("delete receipt carries deleted marker", async () => {
  const stdout = sink();
  const stderr = sink();
  let reads = 0;
  let writes = 0;
  const currentPayload = {
    id: 9,
    is_logged: true,
    started_at: "2026-09-02T12:00:00Z",
    duration: 60,
    note: "Before",
  };
  const current = canonicalTimeEntry(currentPayload, { timezone: "America/Chicago" });
  const configStore = { async read() {
    return { businessId: 123, timezone: "America/Chicago" };
  } };
  const client = { async request(path, options = {}) {
    if (path.endsWith("/time_entries/9") && !options.method) {
      reads += 1;
      return { time_entry: currentPayload };
    }
    if (path.endsWith("/time_entries/9") && options.method === "DELETE") {
      writes += 1;
      return {};
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };

  assert.equal(await run([
    "time", "delete", "9", "--yes", "--guard", current.token, "--json",
  ], {
    stdout,
    stderr,
    configStore,
    client,
  }), 0);

  const result = JSON.parse(stdout.value).data;
  assert.equal(result.mutationKind, "time-entry-delete");
  assert.equal(result.kind, undefined);
  assert.deepEqual(result.changes, [{
    scope: "time-entry:9",
    before: { token: current.token },
    after: { deleted: true },
  }]);
  assert.deepEqual(result.results, [{
    contractVersion: 2,
    kind: "time-entry",
    id: "9",
    exists: false,
    token: null,
  }]);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(stderr.value, "");
});

test("diagnostics status is non-interactive and bounded", async () => {
  const stdout = sink();
  const stderr = sink();
  const configStore = { async read() { return {
    profile: "default",
    clientId: "configured",
    redirectUri: "https://localhost/freshbooks/callback",
    businessId: 123,
    timezone: "America/Chicago",
  }; } };
  const secretStore = { async read() { return { clientSecret: "present", accessToken: "present" }; } };
  assert.equal(await run(["diagnostics", "status", "--json"], { stdout, stderr, configStore, secretStore }), 0);
  const result = JSON.parse(stdout.value).data;
  assert.equal(result.version, "0.2.0");
  assert.equal(result.configured, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.businessSelected, true);
  assert.equal(result.timezone, "America/Chicago");
  assert.ok(result.capabilities.includes("semantic-guards"));
  assert.ok(result.capabilities.includes("popup-onboarding"));
  assert.equal(stderr.value, "");
});

test("auth configure accepts the client secret from stdin without echoing it", async () => {
  const stdout = sink();
  const stderr = sink();
  let storedConfig;
  let storedSecrets;
  const configStore = {
    async read() { return { profile: "default" }; },
    async update(value) { storedConfig = value; },
  };
  const secretStore = {
    backend: "keyring",
    warning: undefined,
    async read() { return {}; },
    async write(profile, value) { storedSecrets = { profile, value }; },
  };

  assert.equal(await run([
    "auth", "configure",
    "--client-id", "synthetic-client",
    "--redirect-uri", "https://localhost/freshbooks/callback",
    "--client-secret-stdin",
    "--json",
  ], {
    stdout,
    stderr,
    configStore,
    secretStore,
    readStdinValue: async () => "synthetic-secret",
  }), 0);

  assert.deepEqual(storedConfig, {
    clientId: "synthetic-client",
    redirectUri: "https://localhost/freshbooks/callback",
  });
  assert.deepEqual(storedSecrets, {
    profile: "default",
    value: { clientSecret: "synthetic-secret" },
  });
  assert.equal(stdout.value.includes("synthetic-secret"), false);
  assert.equal(stderr.value, "");
});

test("auth login accepts the redirect URL from stdin without echoing it", async () => {
  const stdout = sink();
  const stderr = sink();
  let tokenRequest;
  const configStore = { async read() { return {
    profile: "default",
    clientId: "synthetic-client",
    redirectUri: "https://localhost/freshbooks/callback",
    apiBase: "https://api.freshbooks.test",
    authBase: "https://auth.freshbooks.test",
  }; } };
  const secretStore = {
    backend: "keyring",
    warning: undefined,
    async read() { return { clientSecret: "synthetic-secret" }; },
    async write() {},
  };
  const fetcher = async (url, options) => {
    tokenRequest = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      created_at: 1_788_271_200,
      expires_in: 43_200,
    }), { status: 200 });
  };

  assert.equal(await run(["auth", "login", "--code-stdin", "--json"], {
    stdout,
    stderr,
    configStore,
    secretStore,
    fetcher,
    readStdinValue: async () => "https://localhost/freshbooks/callback?code=synthetic-code",
  }), 0);

  assert.equal(tokenRequest.body.code, "synthetic-code");
  assert.equal(stdout.value.includes("synthetic-code"), false);
  assert.equal(stderr.value, "");
});
