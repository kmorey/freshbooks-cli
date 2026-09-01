import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPaths } from "./config.js";
import { CliError } from "./errors.js";
import { runProcess } from "./process.js";

export class SecretStore {
  constructor({ environment = process.env, runner = runProcess } = {}) {
    this.environment = environment;
    this.runner = runner;
    this.credentialsFile =
      environment.FRESHBOOKS_CREDENTIALS_FILE ||
      join(dirname(configPaths(environment).configFile), "credentials.json");
    this.backend = undefined;
    this.warning = undefined;
  }

  async read(profile = "default") {
    this.backend = undefined;
    this.warning = undefined;
    let stored = {};
    let keyringFailure;
    const fileSecrets = await this.readFileStore();
    if (fileSecrets[profile]) {
      this.backend = "file";
      this.warning = fileStoreWarning(this.credentialsFile);
      stored = fileSecrets[profile];
    }

    if (!this.backend) {
    try {
      const result = await this.runner(
        "secret-tool",
        ["lookup", "service", "freshbooks-cli", "profile", profile],
        { ignoreFailure: true },
      );
      if (result.code === 0 && result.stdout.trim()) {
        stored = JSON.parse(result.stdout);
        this.backend = "keyring";
      } else if (result.stderr.trim()) {
        keyringFailure = result.stderr.trim();
      }
    } catch (error) {
      keyringFailure = error.message;
    }
    }

    if (!this.backend) {
      if (keyringFailure && !isUnavailableKeyring(keyringFailure)) {
        throw new CliError(`Could not read credentials from Secret Service: ${keyringFailure}`, {
          code: "SECRET_STORE_ERROR",
        });
      } else {
        this.backend = keyringFailure ? "file" : "keyring";
      }
      if (keyringFailure) this.warning = keyringWarning(keyringFailure, this.credentialsFile);
    }

    return {
      ...stored,
      clientSecret: this.environment.FRESHBOOKS_CLIENT_SECRET || stored.clientSecret,
      accessToken: this.environment.FRESHBOOKS_ACCESS_TOKEN || stored.accessToken,
      refreshToken: this.environment.FRESHBOOKS_REFRESH_TOKEN || stored.refreshToken,
      expiresAt: this.environment.FRESHBOOKS_TOKEN_EXPIRES_AT || stored.expiresAt,
    };
  }

  async write(profile, secrets) {
    const fileSecrets = await this.readFileStore();
    if (fileSecrets[profile]) {
      fileSecrets[profile] = secrets;
      await this.writeFileStore(fileSecrets);
      this.backend = "file";
      this.warning = fileStoreWarning(this.credentialsFile);
      return;
    }

    let result;
    try {
      result = await this.runner(
        "secret-tool",
        [
          "store",
          "--label=FreshBooks CLI credentials",
          "service",
          "freshbooks-cli",
          "profile",
          profile,
        ],
        { input: JSON.stringify(secrets), ignoreFailure: true },
      );
    } catch (error) {
      result = { code: 1, stderr: error.message };
    }

    if (result.code === 0) {
      this.backend = "keyring";
      this.warning = undefined;
      return;
    }

    const failure = result.stderr?.trim() || "Secret Service is unavailable";
    if (!isUnavailableKeyring(failure)) {
      throw new CliError(`Could not save credentials in Secret Service: ${failure}`, {
        code: "SECRET_STORE_ERROR",
      });
    }

    fileSecrets[profile] = secrets;
    await this.writeFileStore(fileSecrets);
    this.backend = "file";
    this.warning = keyringWarning(failure, this.credentialsFile);
  }

  async update(profile, patch) {
    const current = await this.read(profile);
    const next = { ...current, ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    await this.write(profile, next);
    return next;
  }

  async clear(profile) {
    try {
      await this.runner(
        "secret-tool",
        ["clear", "service", "freshbooks-cli", "profile", profile],
        { ignoreFailure: true },
      );
    } catch {}

    const fileSecrets = await this.readFileStore();
    if (fileSecrets[profile]) {
      delete fileSecrets[profile];
      if (Object.keys(fileSecrets).length === 0) {
        await unlink(this.credentialsFile).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else {
        await this.writeFileStore(fileSecrets);
      }
      this.backend = "file";
    }
  }

  async readFileStore() {
    try {
      return JSON.parse(await readFile(this.credentialsFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new CliError(`Could not read ${this.credentialsFile}: ${error.message}`, {
        code: "SECRET_STORE_ERROR",
      });
    }
  }

  async writeFileStore(contents) {
    await mkdir(dirname(this.credentialsFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.credentialsFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.credentialsFile);
  }
}

function isUnavailableKeyring(message) {
  return /Cannot autolaunch D-Bus|Could not connect|org\.freedesktop\.secrets|secret-tool.*ENOENT|spawn secret-tool ENOENT/i.test(
    message,
  );
}

function keyringWarning(failure, credentialsFile) {
  const reason = failure.split("\n", 1)[0];
  return `Secret Service unavailable (${reason}); using ${credentialsFile} with mode 0600.`;
}

function fileStoreWarning(credentialsFile) {
  return `Using file-backed credentials at ${credentialsFile} with mode 0600.`;
}
