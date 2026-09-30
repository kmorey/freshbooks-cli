import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_VERSION,
  TrackingContext,
  canonicalActiveTimers,
  canonicalDeleted,
  canonicalTimerSegment,
  canonicalTimeEntry,
  recordScope,
  semanticEqual,
  semanticToken,
} from "../src/tracking.js";

const timezone = "America/Chicago";

function rawEntry(overrides = {}) {
  return {
    id: 9,
    started_at: "2026-09-02T12:00:00-05:00",
    local_started_at: "2026-09-02T12:00:00",
    duration: 90,
    project_id: 44,
    client_id: 55,
    service_id: 66,
    note: "Work",
    billable: true,
    billed: false,
    ...overrides,
  };
}

function rawSegment(overrides = {}) {
  return {
    id: 10,
    is_logged: false,
    started_at: "2026-09-01T14:00:00.000Z",
    duration: 57,
    project_id: 44,
    client_id: 55,
    service_id: 66,
    note: "Build shell plugin",
    billable: true,
    timer: { id: 901, is_running: false },
    ...overrides,
  };
}

test("canonicalizes identity and optional aliases", () => {
  const numeric = canonicalTimeEntry(rawEntry(), { timezone });
  const stringsAndAliases = canonicalTimeEntry({
    id: "9",
    startedAt: "2026-09-02T17:00:00.000Z",
    localDate: "2026-09-02",
    durationSeconds: 90,
    projectId: "44",
    clientId: "55",
    serviceId: "66",
    note: null,
    billable: true,
    billed: false,
  }, { timezone });

  assert.equal(CONTRACT_VERSION, 2);
  assert.equal(numeric.id, "9");
  assert.deepEqual({
    ...stringsAndAliases,
    token: undefined,
  }, {
    contractVersion: 2,
    kind: "time-entry",
    id: "9",
    exists: true,
    localDate: "2026-09-02",
    startedAt: "2026-09-02T17:00:00.000Z",
    durationSeconds: 90,
    projectId: "44",
    clientId: "55",
    serviceId: "66",
    note: "",
    billable: true,
    billed: false,
    token: undefined,
  });
  assert.match(stringsAndAliases.token, /^[a-f0-9]{64}$/);
  assert.equal(canonicalTimeEntry(rawEntry({ note: undefined, project_id: undefined, client_id: null, service_id: undefined }), { timezone }).note, "");
  assert.deepEqual(
    canonicalTimeEntry(rawEntry({ project_id: undefined, client_id: null, service_id: undefined }), { timezone }),
    canonicalTimeEntry(rawEntry({ project_id: null, client_id: undefined, service_id: null }), { timezone }),
  );
  assert.equal(recordScope(numeric), "time-entry:9");
});

test("requires an explicit valid timezone when deriving localDate", () => {
  const withoutLocalDate = rawEntry({ local_started_at: null });

  assert.throws(
    () => canonicalTimeEntry(withoutLocalDate),
    { code: "INVALID_CANONICAL_TIMEZONE" },
  );
  assert.throws(
    () => canonicalTimeEntry(withoutLocalDate, { timezone: "Not/A_Real_Timezone" }),
    { code: "INVALID_CANONICAL_TIMEZONE" },
  );
});

test("rejects unsafe identities", () => {
  for (const id of [undefined, null, "", "   ", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => canonicalTimeEntry(rawEntry({ id }), { timezone }),
      { code: "INVALID_CANONICAL_ID" },
    );
  }
  assert.throws(() => canonicalDeleted("time-entry", null), { code: "INVALID_CANONICAL_ID" });
});

test("list detail and mutation shapes have identical semantics", () => {
  const list = canonicalTimeEntry(rawEntry(), { timezone });
  const detail = canonicalTimeEntry({ time_entry: rawEntry({ id: "9" }) }, { timezone });
  const mutation = canonicalTimeEntry({ response: { result: { time_entry: rawEntry() } } }, { timezone });

  assert.equal(list.token, detail.token);
  assert.equal(detail.token, mutation.token);
  assert.ok(semanticEqual(list, detail));
  assert.ok(semanticEqual(detail, mutation));
});

test("normalizes NFC without trimming notes", () => {
  const record = canonicalTimeEntry(rawEntry({ note: "Cafe\u0301 " }), { timezone });
  assert.equal(record.note, "Café ");
});

test("each Time Entry field group changes the token", () => {
  const base = canonicalTimeEntry(rawEntry(), { timezone });
  const changes = [
    canonicalTimeEntry(rawEntry({ note: "Other" }), { timezone }),
    canonicalTimeEntry(rawEntry({ duration: 91 }), { timezone }),
    canonicalTimeEntry(rawEntry({ started_at: "2026-09-03T17:00:00Z", local_started_at: "2026-09-03T12:00:00" }), { timezone }),
    canonicalTimeEntry(rawEntry({ project_id: 45, service_id: 67 }), { timezone }),
    canonicalTimeEntry(rawEntry({ billed: true }), { timezone }),
    canonicalDeleted("time-entry", 9),
  ];

  for (const changed of changes) {
    assert.notEqual(changed.token, base.token);
    assert.equal(semanticEqual(base, changed), false);
  }
  assert.equal(canonicalDeleted("time-entry", 9).token, null);
  assert.equal(semanticToken(canonicalDeleted("time-entry", 9)), null);
});

test("list and timer aggregation representations have identical semantics", () => {
  const listSegment = rawSegment();
  const timerSegment = {
    id: "10",
    logged: false,
    startedAt: "2026-09-01T14:00:00Z",
    durationSeconds: 57,
    projectId: "44",
    clientId: "55",
    serviceId: "66",
    note: "Build shell plugin",
    billable: true,
    timerId: "901",
    running: false,
  };

  assert.ok(semanticEqual(
    canonicalTimerSegment(listSegment),
    canonicalTimerSegment({ time_entry: timerSegment }),
  ));
  assert.ok(semanticEqual(
    canonicalActiveTimers([listSegment], { observedAt: "2026-09-01T15:00:00Z" })[0],
    canonicalActiveTimers([timerSegment], { observedAt: "2026-09-01T15:00:00.000Z" })[0],
  ));
});

test("aggregates equal-start segments in stable identity order", () => {
  const segments = [
    rawSegment({ id: "2", duration: null, timer: { id: 901, is_running: true } }),
    rawSegment({ id: "10", is_logged: true, duration: 57 }),
  ];
  const options = { observedAt: "2026-09-01T15:00:00Z" };
  const forward = canonicalActiveTimers(segments, options)[0];
  const reverse = canonicalActiveTimers([...segments].reverse(), options)[0];

  assert.deepEqual(forward.segments.map((segment) => segment.id), ["10", "2"]);
  assert.equal(forward.token, reverse.token);
  assert.equal(forward.state, "running");
  assert.equal(forward.elapsedAnchor.closedSeconds, 57);
  assert.equal(forward.elapsedAnchor.runningStartedAt, "2026-09-01T14:00:00.000Z");
  assert.equal(forward.segments[1].durationSeconds, null);
});

test("running timer metadata comes from the current open segment", () => {
  const open = rawSegment({
    id: "10",
    duration: null,
    project_id: 44,
    client_id: 55,
    service_id: 66,
    note: "Current work",
    billable: true,
    timer: { id: 901, is_running: true },
  });
  const paused = rawSegment({
    id: "2",
    duration: 57,
    project_id: 45,
    client_id: 56,
    service_id: 67,
    note: "Stale work",
    billable: false,
  });

  const timer = canonicalActiveTimers(
    [paused, open],
    { observedAt: "2026-09-01T15:00:00Z" },
  )[0];

  assert.deepEqual(timer.segments.map((segment) => segment.id), ["10", "2"]);
  assert.equal(timer.state, "running");
  assert.deepEqual({
    projectId: timer.projectId,
    clientId: timer.clientId,
    serviceId: timer.serviceId,
    note: timer.note,
    billable: timer.billable,
  }, {
    projectId: "44",
    clientId: "55",
    serviceId: "66",
    note: "Current work",
    billable: true,
  });
});

test("wall clock observation changes no timer token", () => {
  const segments = [rawSegment({
    id: "2",
    duration: null,
    timer: { id: 901, is_running: true },
  })];
  const atThree = canonicalActiveTimers(segments, { observedAt: "2026-09-01T15:00:00Z" })[0];
  const atThreeOhOne = canonicalActiveTimers(segments, { observedAt: "2026-09-01T15:01:00Z" })[0];

  assert.notEqual(atThree.elapsedAnchor.observedAt, atThreeOhOne.elapsedAnchor.observedAt);
  assert.equal(atThree.token, atThreeOhOne.token);
  assert.ok(semanticEqual(atThree, atThreeOhOne));
  assert.notEqual(
    semanticToken({ exists: true, observedAt: atThree.elapsedAnchor.observedAt }),
    semanticToken({ exists: true, observedAt: atThreeOhOne.elapsedAnchor.observedAt }),
  );
});

test("timer field groups change semantics", () => {
  const options = { observedAt: "2026-09-01T15:00:00Z" };
  const timer = (overrides = {}) => canonicalActiveTimers([rawSegment(overrides)], options)[0];
  const base = timer();
  const changes = [
    timer({ note: "Other" }),
    timer({ project_id: 45, service_id: 67 }),
    timer({ billable: false }),
    timer({ duration: null, timer: { id: 901, is_running: true } }),
    timer({ started_at: "2026-09-01T14:01:00Z" }),
  ];

  for (const changed of changes) {
    assert.notEqual(changed.token, base.token);
    assert.equal(semanticEqual(base, changed), false);
  }
});

test("tracking context reuses a remembered canonical record by scope", () => {
  const context = new TrackingContext({
    timezone,
    observedAt: "2026-09-01T15:00:00Z",
  });
  const record = canonicalTimeEntry(rawEntry(), { timezone });

  assert.equal(context.remember(record), record);
  assert.equal(context.get("time-entry:9"), record);
  assert.deepEqual(context.observe({
    queryKey: "time-list",
    coverage: {
      complete: true,
      includesDeleted: false,
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    },
    records: [record],
  }), {
    contractVersion: 2,
    queryKey: "time-list",
    coverage: {
      complete: true,
      includesDeleted: false,
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    },
    records: [record],
  });
});
