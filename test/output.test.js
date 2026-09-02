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
  const configStore = { async read() { return { profile: "default", businessId: 123, timezone: "America/Chicago" }; } };
  const secretStore = { async read() { return { accessToken: "present" }; } };
  assert.equal(await run(["diagnostics", "status", "--json"], { stdout, stderr, configStore, secretStore }), 0);
  const result = JSON.parse(stdout.value).data;
  assert.equal(result.version, "0.2.0");
  assert.equal(result.authenticated, true);
  assert.equal(result.businessSelected, true);
  assert.equal(result.timezone, "America/Chicago");
  assert.ok(result.capabilities.includes("snapshot-guards"));
  assert.equal(stderr.value, "");
});
