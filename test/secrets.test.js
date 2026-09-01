import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "../src/secrets.js";

test("falls back to a mode-0600 credential file when D-Bus cannot be autolaunched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freshbooks-secrets-test-"));
  const secretsFile = join(directory, "config", "freshbooks-cli", "credentials.json");
  const runner = async () => ({
    code: 1,
    stdout: "",
    stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n",
  });
  const store = new SecretStore({
    environment: { XDG_CONFIG_HOME: join(directory, "config") },
    runner,
  });

  await store.write("default", { clientSecret: "not-a-real-secret" });

  assert.equal(store.backend, "file");
  assert.match(store.warning, /D-Bus/);
  assert.equal((await store.read("default")).clientSecret, "not-a-real-secret");
  assert.match(store.warning, /file-backed credentials/);
  assert.equal((await stat(secretsFile)).mode & 0o777, 0o600);
});

test("a profile that falls back to a file stays file-backed when D-Bus later becomes available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "freshbooks-secrets-test-"));
  let keyringAvailable = false;
  let keyringWrites = 0;
  const runner = async (_command, args) => {
    if (!keyringAvailable) {
      return {
        code: 1,
        stdout: "",
        stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n",
      };
    }
    if (args[0] === "store") keyringWrites += 1;
    return { code: args[0] === "lookup" ? 1 : 0, stdout: "", stderr: "" };
  };
  const store = new SecretStore({
    environment: { XDG_CONFIG_HOME: join(directory, "config") },
    runner,
  });

  await store.write("default", { refreshToken: "first" });
  keyringAvailable = true;
  await store.write("default", { refreshToken: "rotated" });

  assert.equal(keyringWrites, 0);
  assert.equal((await store.read("default")).refreshToken, "rotated");
  assert.equal(store.backend, "file");
});
