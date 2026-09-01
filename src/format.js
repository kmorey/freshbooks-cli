import { CliError } from "./errors.js";

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  return `${remainder}s`;
}

export function parseDuration(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidDuration(value);
  }

  if (/^\d+$/.test(value.trim())) return Number(value.trim());

  const match = value.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || !match.slice(1).some(Boolean)) throw invalidDuration(value);
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function invalidDuration(value) {
  return new CliError(`Invalid duration "${value}"; use seconds or a value like 1h30m`, {
    code: "INVALID_ARGUMENT",
    exitCode: 2,
  });
}

export function parseDate(value, flag) {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CliError(`--${flag} must be a valid date or ISO timestamp`, {
      code: "INVALID_ARGUMENT",
      exitCode: 2,
    });
  }
  return date;
}

export function elapsedSeconds(entry, now = new Date()) {
  if (entry.is_logged === true || entry.timer?.is_running === false) {
    return Math.max(0, Number(entry.duration) || 0);
  }
  const startedAt = new Date(entry.started_at);
  if (Number.isNaN(startedAt.getTime())) return Number(entry.duration) || 0;
  const wallClockSeconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
  return Math.max(Number(entry.duration) || 0, wallClockSeconds);
}
