import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { CliError } from "./errors.js";

export function configPaths(environment = process.env) {
  const configHome = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  const stateHome = environment.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return {
    configFile: join(configHome, "freshbooks-cli", "config.json"),
    refreshLock: join(stateHome, "freshbooks-cli", "refresh.lock"),
  };
}

export class ConfigStore {
  constructor({ environment = process.env, paths = configPaths(environment) } = {}) {
    this.environment = environment;
    this.paths = paths;
  }

  async read() {
    let stored = {};
    try {
      stored = JSON.parse(await readFile(this.paths.configFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new CliError(`Could not read ${this.paths.configFile}: ${error.message}`, {
          code: "CONFIG_ERROR",
        });
      }
    }

    return {
      ...stored,
      clientId: this.environment.FRESHBOOKS_CLIENT_ID || stored.clientId,
      redirectUri: this.environment.FRESHBOOKS_REDIRECT_URI || stored.redirectUri,
      businessId: numberFromEnvironment(this.environment.FRESHBOOKS_BUSINESS_ID) || stored.businessId,
      apiBase: this.environment.FRESHBOOKS_API_BASE || stored.apiBase || "https://api.freshbooks.com",
      authBase: this.environment.FRESHBOOKS_AUTH_BASE || stored.authBase || "https://auth.freshbooks.com",
      profile: this.environment.FRESHBOOKS_PROFILE || stored.profile || "default",
    };
  }

  async update(patch) {
    const current = await this.readStored();
    const next = { ...current, ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }

    await mkdir(dirname(this.paths.configFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.paths.configFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.paths.configFile);
    return next;
  }

  async readStored() {
    try {
      return JSON.parse(await readFile(this.paths.configFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
}

function numberFromEnvironment(value) {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
