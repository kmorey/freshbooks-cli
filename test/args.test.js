import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/args.js";

test("parseArgs accepts global JSON and command options in any position", () => {
  assert.deepEqual(parseArgs(["timer", "start", "--project", "42", "--json", "--billable"]), {
    positionals: ["timer", "start"],
    options: { project: "42", json: true, billable: true },
  });
});

test("parseArgs supports explicit false boolean options", () => {
  assert.deepEqual(parseArgs(["time", "update", "7", "--no-billable"]), {
    positionals: ["time", "update", "7"],
    options: { billable: false },
  });
});

test("parseArgs recognizes include-unlogged as a boolean", () => {
  assert.equal(parseArgs(["time", "list", "--include-unlogged"]).options.includeUnlogged, true);
});

test("parseArgs recognizes secret and authorization code stdin flags", () => {
  assert.deepEqual(
    parseArgs(["auth", "configure", "--client-secret-stdin", "--code-stdin"]).options,
    { clientSecretStdin: true, codeStdin: true },
  );
});

test("parseArgs recognizes the version flag without a command", () => {
  assert.equal(parseArgs(["--version"]).options.version, true);
});
