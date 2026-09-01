import { setTimeout as delay } from "node:timers/promises";
import { ApiError, CliError } from "./errors.js";
import { refreshAccessToken, withRefreshLock } from "./auth.js";

export class FreshBooksClient {
  constructor({ configStore, secretStore, fetcher = fetch, now = () => new Date() }) {
    this.configStore = configStore;
    this.secretStore = secretStore;
    this.fetcher = fetcher;
    this.now = now;
  }

  async request(
    path,
    { method = "GET", query, body, headers: extraHeaders, retryAuth = true, retryRate = 0 } = {},
  ) {
    const config = await this.configStore.read();
    const token = await this.accessToken(config);
    const url = new URL(path, config.apiBase);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...extraHeaders,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetcher(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 401 && retryAuth) {
      await this.forceRefresh(config, { rejectedToken: token });
      return this.request(path, {
        method,
        query,
        body,
        headers: extraHeaders,
        retryAuth: false,
        retryRate,
      });
    }
    if (response.status === 429 && retryRate < 3) {
      const retryAfter = Math.min(10, Math.max(1, Number(response.headers.get("retry-after")) || 1));
      await delay(retryAfter * 1000);
      return this.request(path, {
        method,
        query,
        body,
        headers: extraHeaders,
        retryAuth,
        retryRate: retryRate + 1,
      });
    }

    const payload = await responsePayload(response);
    if (!response.ok) {
      throw new ApiError(apiMessage(payload, response.status), {
        status: response.status,
        details: payload,
      });
    }
    return payload;
  }

  async accessToken(config) {
    const secrets = await this.secretStore.read(config.profile);
    if (!secrets.accessToken) {
      throw new CliError("Run `freshbooks auth login` first", { code: "AUTH_REQUIRED", exitCode: 4 });
    }
    const expiry = secrets.expiresAt ? new Date(secrets.expiresAt).getTime() : Number.POSITIVE_INFINITY;
    if (expiry - this.now().getTime() > 60_000) return secrets.accessToken;
    return this.forceRefresh(config);
  }

  async forceRefresh(config, { rejectedToken } = {}) {
    return withRefreshLock(this.configStore.paths.refreshLock, async () => {
      const latest = await this.secretStore.read(config.profile);
      const expiry = latest.expiresAt ? new Date(latest.expiresAt).getTime() : 0;
      if (rejectedToken && latest.accessToken && latest.accessToken !== rejectedToken) {
        return latest.accessToken;
      }
      if (!rejectedToken && expiry - this.now().getTime() > 60_000) return latest.accessToken;
      const refreshed = await refreshAccessToken({ config, secrets: latest, fetcher: this.fetcher });
      await this.secretStore.write(config.profile, { ...latest, ...refreshed });
      return refreshed.accessToken;
    });
  }
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function apiMessage(payload, status) {
  if (typeof payload === "string") return payload;
  return (
    payload?.error_description ||
    payload?.error?.message ||
    payload?.message ||
    payload?.response?.errors?.[0]?.message ||
    `FreshBooks API returned HTTP ${status}`
  );
}
