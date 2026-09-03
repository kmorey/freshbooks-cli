import test from "node:test";
import assert from "node:assert/strict";
import { elapsedSeconds, formatDuration, parseDuration, parseRangeDate } from "../src/format.js";

test("duration parsing supports compact shell-friendly values", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("45m10s"), 2710);
  assert.equal(parseDuration("90"), 90);
  assert.equal(formatDuration(5410), "1h 30m");
});

test("elapsedSeconds uses wall-clock time for an active timer", () => {
  assert.equal(
    elapsedSeconds({ started_at: "2026-09-01T14:00:00Z", duration: 0 }, new Date("2026-09-01T14:42:05Z")),
    2525,
  );
});

test("elapsedSeconds trusts server duration when a timer is paused", () => {
  assert.equal(
    elapsedSeconds(
      {
        is_logged: false,
        started_at: "2026-09-01T14:00:00Z",
        duration: 600,
        timer: { is_running: false },
      },
      new Date("2026-09-01T16:00:00Z"),
    ),
    600,
  );
});

test("parseRangeDate includes the complete local final day", () => {
  const start = parseRangeDate("2026-09-02", "from");
  assert.equal(start.getDate(), 2);
  assert.equal(start.getHours(), 0);
  const end = parseRangeDate("2026-09-02", "to", { endOfDay: true });
  assert.equal(end.getFullYear(), 2026);
  assert.equal(end.getMonth(), 8);
  assert.equal(end.getDate(), 2);
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
  assert.equal(end.getSeconds(), 59);
  assert.equal(end.getMilliseconds(), 999);
});
