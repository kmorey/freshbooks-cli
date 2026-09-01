import test from "node:test";
import assert from "node:assert/strict";
import { Output } from "../src/output.js";
import { CliError } from "../src/errors.js";

function sink() {
  return { value: "", write(chunk) { this.value += chunk; } };
}

test("JSON output is a stable one-object envelope", () => {
  const stdout = sink();
  const stderr = sink();
  const output = new Output({ json: true, stdout, stderr });
  output.success({ active: false, timers: [] });
  assert.deepEqual(JSON.parse(stdout.value), { ok: true, data: { active: false, timers: [] } });
  assert.equal(stderr.value, "");
});

test("JSON errors carry a machine-readable code", () => {
  const stdout = sink();
  const stderr = sink();
  const output = new Output({ json: true, stdout, stderr });
  assert.equal(output.error(new CliError("Login required", { code: "AUTH_REQUIRED", exitCode: 4 })), 4);
  assert.deepEqual(JSON.parse(stderr.value), {
    ok: false,
    error: { code: "AUTH_REQUIRED", message: "Login required" },
  });
});
