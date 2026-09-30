import { createHash } from "node:crypto";
import { CliError } from "./errors.js";

export const CONTRACT_VERSION = 2;

const OMIT = Symbol("omit");

export class TrackingContext {
  constructor({ timezone, observedAt }) {
    this.timezone = timezone;
    this.observedAt = canonicalInstant(observedAt);
    this.records = new Map();
  }

  remember(record) {
    this.records.set(recordScope(record), record);
    return record;
  }

  get(scope) {
    return this.records.get(scope);
  }

  observe({ queryKey, coverage, records }) {
    const canonicalRecords = records.map((record) => this.remember(record));
    return {
      contractVersion: CONTRACT_VERSION,
      queryKey,
      coverage: {
        complete: coverage.complete === true,
        includesDeleted: coverage.includesDeleted === true,
        fromDate: coverage.fromDate ?? null,
        toDate: coverage.toDate ?? null,
      },
      records: canonicalRecords,
    };
  }
}

export function canonicalTimeEntry(payload, { timezone } = {}) {
  const raw = unwrapTimeEntry(payload);
  const startedAt = canonicalInstant(value(raw, "started_at", "startedAt"));
  const explicitLocalDate = value(raw, "local_date", "localDate");
  const localStartedAt = value(raw, "local_started_at", "localStartedAt");
  const record = {
    contractVersion: CONTRACT_VERSION,
    kind: "time-entry",
    id: canonicalId(raw?.id),
    exists: true,
    localDate: canonicalLocalDate(explicitLocalDate ?? localStartedAt, startedAt, timezone),
    startedAt,
    durationSeconds: canonicalDuration(value(raw, "duration", "duration_seconds", "durationSeconds")),
    projectId: canonicalOptionalId(value(raw, "project_id", "projectId")),
    clientId: canonicalOptionalId(value(raw, "client_id", "clientId")),
    serviceId: canonicalOptionalId(value(raw, "service_id", "serviceId")),
    note: canonicalText(raw?.note),
    billable: canonicalBoolean(raw?.billable),
    billed: canonicalBoolean(raw?.billed),
  };
  return { ...record, token: semanticToken(record) };
}

export function canonicalTimerSegment(payload) {
  const raw = unwrapTimeEntry(payload);
  const duration = value(raw, "duration", "duration_seconds", "durationSeconds");
  const durationSeconds = duration == null ? null : canonicalDuration(duration);
  const logged = canonicalBoolean(value(raw, "is_logged", "logged"));
  const record = {
    contractVersion: CONTRACT_VERSION,
    kind: "timer-segment",
    id: canonicalId(raw?.id),
    timerId: canonicalId(value(raw?.timer, "id") ?? value(raw, "timer_id", "timerId")),
    exists: true,
    startedAt: canonicalInstant(value(raw, "started_at", "startedAt")),
    durationSeconds,
    running: !logged && durationSeconds === null,
    logged,
  };
  return { ...record, token: semanticToken(record) };
}

export function canonicalActiveTimers(rawSegments, { observedAt } = {}) {
  const canonicalObservedAt = canonicalInstant(observedAt);
  const groups = new Map();

  for (const payload of rawSegments) {
    const raw = unwrapTimeEntry(payload);
    const timerIdentity = value(raw?.timer, "id") ?? value(raw, "timer_id", "timerId");
    if (timerIdentity == null) continue;
    const segment = canonicalTimerSegment(raw);
    const group = groups.get(segment.timerId) || [];
    group.push({ raw, segment });
    groups.set(segment.timerId, group);
  }

  const timers = [];
  for (const [id, group] of groups) {
    if (!group.some(({ segment }) => !segment.logged)) continue;
    group.sort(({ segment: left }, { segment: right }) => {
      if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? -1 : 1;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
    const activeSegments = group.filter(({ segment }) => !segment.logged);
    const openEntry = activeSegments.filter(({ segment }) => segment.running).at(-1) || null;
    const source = (openEntry || activeSegments.at(-1)).raw;
    const segments = group.map(({ segment }) => segment);
    const openSegment = openEntry?.segment || null;
    const record = {
      contractVersion: CONTRACT_VERSION,
      kind: "active-timer",
      id,
      exists: true,
      segments,
      state: openSegment ? "running" : "paused",
      elapsedAnchor: {
        closedSeconds: segments.reduce(
          (total, segment) => total + (segment.durationSeconds ?? 0),
          0,
        ),
        runningStartedAt: openSegment?.startedAt ?? null,
        observedAt: canonicalObservedAt,
      },
      projectId: canonicalOptionalId(value(source, "project_id", "projectId")),
      clientId: canonicalOptionalId(value(source, "client_id", "clientId")),
      serviceId: canonicalOptionalId(value(source, "service_id", "serviceId")),
      note: canonicalText(source?.note),
      billable: canonicalBoolean(source?.billable),
    };
    timers.push({ ...record, token: semanticToken(record) });
  }
  return timers.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function canonicalDeleted(kind, id) {
  if (kind !== "time-entry" && kind !== "active-timer") {
    throw new CliError(`Invalid canonical record kind: ${String(kind)}`, {
      code: "INVALID_CANONICAL_KIND",
    });
  }
  return {
    contractVersion: CONTRACT_VERSION,
    kind,
    id: canonicalId(id),
    exists: false,
    token: null,
  };
}

export function semanticToken(record) {
  if (record?.exists === false) return null;
  return createHash("sha256").update(stableJson(semanticData(record))).digest("hex");
}

export function semanticEqual(left, right) {
  return stableJson(semanticData(left)) === stableJson(semanticData(right));
}

export function assertGuard(expectedToken, current) {
  if (expectedToken === undefined || expectedToken === current.token) return;
  throw new CliError("The FreshBooks record changed since it was loaded", {
    code: "GUARD_REJECTED",
    details: {
      contractVersion: CONTRACT_VERSION,
      identity: { kind: current.kind, id: current.id },
      expectedToken,
      currentToken: current.token,
      current,
    },
  });
}

export function recordScope(record) {
  if (!record || typeof record.kind !== "string" || record.kind.length === 0) {
    throw new CliError("Canonical record scope requires a kind", {
      code: "INVALID_CANONICAL_KIND",
    });
  }
  return `${record.kind}:${canonicalId(record.id)}`;
}

function unwrapTimeEntry(payload) {
  const candidates = [
    payload?.time_entry,
    payload?.timeEntry,
    payload?.result?.time_entry,
    payload?.result?.timeEntry,
    payload?.response?.time_entry,
    payload?.response?.timeEntry,
    payload?.response?.result?.time_entry,
    payload?.response?.result?.timeEntry,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === "object")
    || payload
    || {};
}

function value(object, ...keys) {
  for (const key of keys) {
    if (object != null && object[key] !== undefined) return object[key];
  }
  return undefined;
}

function canonicalId(identity) {
  if (typeof identity === "number") {
    if (!Number.isSafeInteger(identity)) throw invalidId(identity);
    return String(identity);
  }
  if (typeof identity !== "string") throw invalidId(identity);
  const normalized = identity.normalize("NFC").trim();
  if (normalized.length === 0) throw invalidId(identity);
  return normalized;
}

function canonicalOptionalId(identity) {
  return identity == null ? null : canonicalId(identity);
}

function invalidId(identity) {
  return new CliError(`Invalid canonical identity: ${String(identity)}`, {
    code: "INVALID_CANONICAL_ID",
  });
}

function canonicalText(text) {
  return text == null ? "" : String(text).normalize("NFC");
}

function canonicalBoolean(valueToNormalize) {
  return valueToNormalize === true || valueToNormalize === 1 || valueToNormalize === "true";
}

function canonicalDuration(duration) {
  const numeric = Number(duration);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function canonicalInstant(instant) {
  const parsed = new Date(instant);
  if (instant == null || Number.isNaN(parsed.getTime())) {
    throw new CliError(`Invalid canonical instant: ${String(instant)}`, {
      code: "INVALID_CANONICAL_INSTANT",
    });
  }
  return parsed.toISOString();
}

function canonicalLocalDate(localValue, startedAt, timezone) {
  if (localValue != null) {
    const date = String(localValue).slice(0, 10);
    if (isDateKey(date)) return date;
    throw new CliError(`Invalid canonical local date: ${String(localValue)}`, {
      code: "INVALID_CANONICAL_DATE",
    });
  }
  if (typeof timezone !== "string" || timezone.length === 0) {
    throw new CliError(`Invalid canonical timezone: ${String(timezone)}`, {
      code: "INVALID_CANONICAL_TIMEZONE",
    });
  }
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(startedAt)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    throw new CliError(`Invalid canonical timezone: ${String(timezone)}`, {
      code: "INVALID_CANONICAL_TIMEZONE",
    });
  }
}

function isDateKey(valueToCheck) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valueToCheck);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === valueToCheck;
}

function semanticData(valueToNormalize, path = []) {
  if (Array.isArray(valueToNormalize)) {
    return valueToNormalize.map((item, index) => semanticData(item, [...path, String(index)]));
  }
  if (valueToNormalize === null || typeof valueToNormalize !== "object") return valueToNormalize;

  const normalized = {};
  for (const key of Object.keys(valueToNormalize).sort()) {
    const child = semanticField(valueToNormalize[key], [...path, key]);
    if (child !== OMIT) normalized[key] = child;
  }
  return normalized;
}

function semanticField(fieldValue, path) {
  const key = path.at(-1);
  const parent = path.at(-2);
  if (key === "token") return OMIT;
  if (key === "observedAt" && parent === "elapsedAnchor") return OMIT;
  if (key === "raw" || key === "rawPayload" || key === "rawResponse") return OMIT;
  if (key === "requestMetadata" || key === "requestId" || key === "causalTag") return OMIT;
  if (key === "display" || key === "displayText" || key.endsWith("Display")) return OMIT;
  return semanticData(fieldValue, path);
}

function stableJson(valueToSerialize) {
  return JSON.stringify(valueToSerialize);
}
