import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_VERSION,
  canonicalDeleted,
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
