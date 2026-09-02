import test from "node:test";
import assert from "node:assert/strict";
import { Output } from "../src/output.js";
import { CliError } from "../src/errors.js";
import { run } from "../src/cli.js";

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
  assert.ok(result.capabilities.includes("snapshot-guards"));
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
