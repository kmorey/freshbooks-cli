import { randomBytes } from "node:crypto";
import { open, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError, CliError } from "./errors.js";

export function authorizationUrl(config, state = randomBytes(24).toString("hex")) {
  requireAuthConfiguration(config);
  const url = new URL("/oauth/authorize/", config.authBase);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

export function extractAuthorizationCode(value) {
  if (!value) throw new CliError("No authorization code was provided", { code: "AUTH_CODE_REQUIRED" });
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const error = url.searchParams.get("error");
    if (error) throw new CliError(`FreshBooks authorization failed: ${error}`, { code: "AUTH_DENIED" });
    return url.searchParams.get("code") || trimmed;
  } catch (error) {
    if (error instanceof CliError) throw error;
    return trimmed;
  }
}

export async function exchangeAuthorizationCode({ config, secrets, code, fetcher = fetch }) {
  requireAuthConfiguration(config);
  if (!secrets.clientSecret) {
    throw new CliError("FreshBooks client secret is not configured", { code: "AUTH_NOT_CONFIGURED" });
  }
  return requestToken(
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: secrets.clientSecret,
      redirect_uri: config.redirectUri,
      code: extractAuthorizationCode(code),
    },
    config.apiBase,
    fetcher,
  );
}

export async function refreshAccessToken({ config, secrets, fetcher = fetch }) {
  requireAuthConfiguration(config);
  if (!secrets.clientSecret || !secrets.refreshToken) {
    throw new CliError("FreshBooks login is required", { code: "AUTH_REQUIRED", exitCode: 4 });
  }
  return requestToken(
    {
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: secrets.clientSecret,
      redirect_uri: config.redirectUri,
      refresh_token: secrets.refreshToken,
    },
    config.apiBase,
    fetcher,
  );
}

async function requestToken(body, apiBase, fetcher) {
  const response = await fetcher(new URL("/auth/oauth/token", apiBase), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new ApiError(payload?.error_description || payload?.error || "FreshBooks token request failed", {
      code: "AUTH_TOKEN_ERROR",
      status: response.status,
      details: payload,
    });
  }
  const createdAt = Number(payload.created_at) || Math.floor(Date.now() / 1000);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date((createdAt + Number(payload.expires_in || 0)) * 1000).toISOString(),
    scope: payload.scope,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function requireAuthConfiguration(config) {
  if (!config.clientId || !config.redirectUri) {
    throw new CliError("Run `freshbooks auth configure` first", { code: "AUTH_NOT_CONFIGURED" });
  }
}

export async function withRefreshLock(lockPath, callback, { timeoutMs = 5000 } = {}) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
        return await callback();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CliError("Timed out waiting for another FreshBooks token refresh", {
          code: "AUTH_REFRESH_BUSY",
        });
      }
      await delay(75);
    }
  }
}
