import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "..");
const installer = join(repositoryRoot, "install.sh");

async function createReleaseFixture(root, { validChecksum = true } = {}) {
  const releaseDirectory = join(root, "release");
  const packageDirectory = join(root, "fixture", "package");
  await mkdir(releaseDirectory, { recursive: true });
  await mkdir(packageDirectory, { recursive: true });
  for (const path of ["bin", "src", "package.json", "README.md", "LICENSE"]) {
    await cp(join(repositoryRoot, path), join(packageDirectory, path), { recursive: true });
  }
  await chmod(join(packageDirectory, "bin", "freshbooks.js"), 0o755);

  const archive = join(releaseDirectory, "freshbooks-cli.tar.gz");
  await execFile("tar", ["-czf", archive, "-C", join(root, "fixture"), "package"]);
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(
    `${archive}.sha256`,
    `${validChecksum ? digest : "0".repeat(64)}  freshbooks-cli.tar.gz\n`,
  );
  return releaseDirectory;
}

function installerEnvironment(home, releaseDirectory) {
  return {
    ...process.env,
    HOME: home,
    FRESHBOOKS_CLI_RELEASE_BASE_URL: pathToFileURL(releaseDirectory).href,
  };
}

test("installer installs, verifies, runs, and uninstalls without removing credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "freshbooks-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const prefix = join(home, ".local");
  const releaseDirectory = await createReleaseFixture(root);
  const environment = installerEnvironment(home, releaseDirectory);

  const installed = await execFile("sh", [installer, "--prefix", prefix], { env: environment });
  assert.match(installed.stdout, /Installed freshbooks-cli 0\.2\.0/);

  const command = join(prefix, "bin", "freshbooks");
  assert.equal((await stat(command)).isFile(), true);
  await execFile(command, ["--help"], { env: environment });

  const credentials = join(home, ".config", "freshbooks-cli", "credentials.json");
  await mkdir(join(home, ".config", "freshbooks-cli"), { recursive: true });
  await writeFile(credentials, '{"fixture":true}\n', { mode: 0o600 });

  const removed = await execFile("sh", [installer, "--uninstall", "--prefix", prefix], {
    env: environment,
  });
  assert.match(removed.stdout, /Configuration and credentials were preserved/);
  assert.equal(JSON.parse(await readFile(credentials, "utf8")).fixture, true);
  await assert.rejects(stat(command), { code: "ENOENT" });
});

test("installer rejects a release with an invalid checksum", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "freshbooks-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const prefix = join(home, ".local");
  const releaseDirectory = await createReleaseFixture(root, { validChecksum: false });

  await assert.rejects(
    execFile("sh", [installer, "--prefix", prefix], {
      env: installerEnvironment(home, releaseDirectory),
    }),
  );
  await assert.rejects(stat(join(prefix, "bin", "freshbooks")), { code: "ENOENT" });
});

test("installer preserves an existing unmanaged freshbooks command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "freshbooks-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const prefix = join(home, ".local");
  const command = join(prefix, "bin", "freshbooks");
  const releaseDirectory = await createReleaseFixture(root);
  await mkdir(join(prefix, "bin"), { recursive: true });
  await writeFile(command, "existing command\n");

  await assert.rejects(
    execFile("sh", [installer, "--prefix", prefix], {
      env: installerEnvironment(home, releaseDirectory),
    }),
  );
  assert.equal(await readFile(command, "utf8"), "existing command\n");
});
