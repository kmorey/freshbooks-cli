import { setTimeout as delay } from "node:timers/promises";
import { ApiError, CliError } from "./errors.js";
import { refreshAccessToken, withRefreshLock } from "./auth.js";

const NETWORK_TIMEOUT_MS = 15_000;
const AUTH_REPLAY_COUNT = 1;
const MAX_RATE_RETRIES = 3;
const MAX_RATE_WAIT_MS = 10_000;
const DEADLINE_SLACK_MS = 4_000;
const REQUEST_BUDGET_MS =
  NETWORK_TIMEOUT_MS * (1 + AUTH_REPLAY_COUNT)
  + MAX_RATE_RETRIES * MAX_RATE_WAIT_MS
  + DEADLINE_SLACK_MS;

export const COMMAND_BUDGETS_MS = Object.freeze({
  read: REQUEST_BUDGET_MS,
  singleWrite: REQUEST_BUDGET_MS * 2,
  multiSegment: REQUEST_BUDGET_MS * 5,
  log: REQUEST_BUDGET_MS * 3,
  switch: REQUEST_BUDGET_MS * 5,
});

export class FreshBooksClient {
  constructor({
    configStore,
    secretStore,
    fetcher = fetch,
    now = () => new Date(),
    timeoutMs = NETWORK_TIMEOUT_MS,
    requestBudgetMs = REQUEST_BUDGET_MS,
    sleeper = delay,
    clock = Date.now,
  }) {
    this.configStore = configStore;
    this.secretStore = secretStore;
    this.fetcher = fetcher;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.requestBudgetMs = requestBudgetMs;
    this.sleeper = sleeper;
    this.clock = clock;
  }

  async request(path, options = {}) {
    const method = options.method || "GET";
    const deadline = {
      at: this.clock() + this.requestBudgetMs,
      clock: this.clock,
      signal: AbortSignal.timeout(this.requestBudgetMs),
    };
    try {
      return await this.requestWithRetries(path, options, deadline);
    } catch (error) {
      if (deadline.signal.aborted || isTimeout(error)) throw timeoutError(method);
      throw error;
    }
  }

  async requestWithRetries(
    path,
    { method = "GET", query, body, headers: extraHeaders, retryAuth = true, retryRate = 0 },
    deadline,
  ) {
    throwIfExpired(deadline);
    const config = await withinDeadline(this.configStore.read(), deadline);
    const token = await this.accessToken(config, deadline);
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

    const requestSignal = this.networkSignal(deadline);
    let response;
    try {
      response = await withinDeadline(this.fetcher(url, {
        method,
        headers,
        signal: requestSignal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), deadline, requestSignal);
    } catch (error) {
      if (isTimeout(error) || requestSignal.aborted) throw timeoutError(method);
      throw new CliError("FreshBooks API transport failed", {
        code: "API_TRANSPORT",
        exitCode: 3,
        outcomeUnknown: method !== "GET",
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    if (response.status === 401 && retryAuth) {
      await this.forceRefresh(config, { rejectedToken: token, deadline });
      return this.requestWithRetries(path, {
        method,
        query,
        body,
        headers: extraHeaders,
        retryAuth: false,
        retryRate,
      }, deadline);
    }
    if (response.status === 429 && retryRate < MAX_RATE_RETRIES) {
      const retryAfter = Math.min(
        MAX_RATE_WAIT_MS / 1000,
        Math.max(1, Number(response.headers.get("retry-after")) || 1),
      );
      await withinDeadline(
        this.sleeper(retryAfter * 1000, undefined, { signal: deadline.signal }),
        deadline,
      );
      return this.requestWithRetries(path, {
        method,
        query,
        body,
        headers: extraHeaders,
        retryAuth,
        retryRate: retryRate + 1,
      }, deadline);
    }

    const payload = await withinDeadline(responsePayload(response), deadline, requestSignal);
    if (!response.ok) {
      throw new ApiError(apiMessage(payload, response.status), {
        status: response.status,
        details: payload,
        outcomeUnknown: method !== "GET" && response.status >= 500,
      });
    }
    return payload;
  }

  networkSignal(deadline) {
    throwIfExpired(deadline);
    return AbortSignal.any([
      deadline.signal,
      AbortSignal.timeout(Math.min(this.timeoutMs, remainingMs(deadline))),
    ]);
  }

  async accessToken(config, deadline) {
    const secrets = await withinDeadline(this.secretStore.read(config.profile), deadline);
    if (!secrets.accessToken) {
      throw new CliError("Run `freshbooks auth login` first", { code: "AUTH_REQUIRED", exitCode: 4 });
    }
    const expiry = secrets.expiresAt ? new Date(secrets.expiresAt).getTime() : Number.POSITIVE_INFINITY;
    if (expiry - this.now().getTime() > 60_000) return secrets.accessToken;
    return this.forceRefresh(config, { deadline });
  }

  async forceRefresh(config, { rejectedToken, deadline }) {
    throwIfExpired(deadline);
    return withinDeadline(withRefreshLock(this.configStore.paths.refreshLock, async () => {
      const latest = await withinDeadline(this.secretStore.read(config.profile), deadline);
      const expiry = latest.expiresAt ? new Date(latest.expiresAt).getTime() : 0;
      if (rejectedToken && latest.accessToken && latest.accessToken !== rejectedToken) {
        return latest.accessToken;
      }
      if (!rejectedToken && expiry - this.now().getTime() > 60_000) return latest.accessToken;
      const refreshSignal = this.networkSignal(deadline);
      const fetcher = async (url, options = {}) => {
        const signal = options.signal
          ? AbortSignal.any([options.signal, refreshSignal])
          : refreshSignal;
        const response = await withinDeadline(
          this.fetcher(url, { ...options, signal }),
          deadline,
          signal,
        );
        return boundedResponse(response, signal, deadline);
      };
      const refreshed = await refreshAccessToken({ config, secrets: latest, fetcher });
      throwIfExpired(deadline);
      await withinDeadline(
        this.secretStore.write(config.profile, { ...latest, ...refreshed }),
        deadline,
      );
      return refreshed.accessToken;
    }, { timeoutMs: remainingMs(deadline) }), deadline);
  }
}

function remainingMs(deadline) {
  return Math.max(1, deadline.at - deadline.clock());
}

function throwIfExpired(deadline) {
  if (deadline.signal.aborted || deadline.clock() >= deadline.at) {
    throw deadline.signal.reason || Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }
}

function isTimeout(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError";
}

function timeoutError(method) {
  return new CliError("FreshBooks API request timed out", {
    code: "API_TIMEOUT",
    exitCode: 3,
    outcomeUnknown: method !== "GET",
  });
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function withinDeadline(promise, deadline, signal = deadline.signal) {
  const value = await withAbort(promise, signal);
  throwIfExpired(deadline);
  return value;
}

function boundedResponse(response, signal, deadline) {
  return new Proxy(response, {
    get(target, property) {
      if (property === "text") {
        return () => withinDeadline(target.text(), deadline, signal);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
