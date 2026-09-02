import test from "node:test";
import assert from "node:assert/strict";
import { FreshBooksService, groupTimerSegments, presentTimeEntry } from "../src/freshbooks.js";

const businessId = 123;
const now = () => new Date("2026-09-01T15:00:00Z");
const configStore = { async read() { return { businessId, timezone: "America/Chicago" }; }, async update() {} };

function segment(overrides = {}) {
  return {
    id: 900, identity_id: 88, is_logged: false, duration: null,
    note: "Build shell plugin", internal: false,
    started_at: "2026-09-01T14:59:00Z", local_started_at: "2026-09-01T14:59:00Z",
    local_timezone: "America/Chicago", billable: true, billed: false,
    timer: { id: 901, is_running: true }, client_id: 55, project_id: 44, service_id: 66,
    ...overrides,
  };
}

test("groups timer segments by timer identity and ignores bare unlogged entries", () => {
  const timers = groupTimerSegments([
    segment({ id: 1, duration: 57, started_at: "2026-09-01T14:00:00Z" }),
    segment({ id: 2, started_at: "2026-09-01T14:59:00Z" }),
    segment({ id: 3, timer: undefined }),
  ], now());
  assert.equal(timers.length, 1);
  assert.equal(timers[0].id, 901);
  assert.deepEqual(timers[0].segmentIds, [1, 2]);
  assert.equal(timers[0].running, true);
  assert.equal(timers[0].elapsedSeconds, 117);
});

test("normalizes project/client joins and logged time entries for plugins", async () => {
  const client = { async request(path) {
    if (path === "/auth/api/v1/users/me") return { response: { id: 88, business_memberships: [{ business: { id: 123, account_id: "abc", active: true } }] } };
    if (path === "/projects/business/123/projects") return { projects: [{ id: 44, title: "Build", client_id: 55, active: true, services: [{ id: 66, name: "Development", billable: true, vis_state: 0 }] }] };
    if (path === "/accounting/account/abc/users/clients") return { response: { result: { clients: [{ id: 55, organization: "Example Client" }] } } };
    throw new Error(`Unexpected request: ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore });
  assert.deepEqual(await service.projectRecords(), [{
    id: 44, title: "Build", clientId: 55, clientName: "Example Client",
    active: true, complete: false, internal: false,
    services: [{ id: 66, name: "Development", billable: true }],
  }]);
  const normalized = presentTimeEntry({ id: 9, is_logged: true, started_at: "2026-09-02T12:00:00Z", duration: 90, project_id: 44, note: "Work" });
  assert.deepEqual({ ...normalized, snapshotToken: undefined }, {
    id: 9, startedAt: "2026-09-02T12:00:00Z", localStartedAt: null, localDate: "2026-09-02",
    durationSeconds: 90, projectId: 44, clientId: null, serviceId: null, note: "Work", billable: false, billed: false, snapshotToken: undefined,
  });
  assert.match(normalized.snapshotToken, /^[a-f0-9]{64}$/);
  assert.equal(
    presentTimeEntry({ id: 10, started_at: "2026-09-03T02:00:00Z", duration: 1 }, { timezone: "America/Chicago" }).localDate,
    "2026-09-02",
  );
  assert.deepEqual(await service.clientRecords(), [{
    id: 55, name: "Example Client", organization: "Example Client", active: true,
  }]);
});

test("converts FreshBooks-local calendar dates at DST-aware boundaries", async () => {
  const timezoneConfig = {
    async read() { return { businessId, timezone: "America/Chicago" }; },
    async update() {},
  };
  const service = new FreshBooksService({ client: {}, configStore: timezoneConfig });
  assert.deepEqual(await service.localDateFields("2026-03-08"), {
    started_at: "2026-03-08T17:00:00.000Z",
    local_started_at: "2026-03-08T12:00:00",
    local_timezone: "America/Chicago",
  });
  assert.equal((await service.localRangeBoundary("2026-03-08")).toISOString(), "2026-03-08T06:00:00.000Z");
  assert.equal(
    (await service.localRangeBoundary("2026-03-08", { endOfDay: true })).toISOString(),
    "2026-03-09T04:59:59.999Z",
  );
  await assert.rejects(service.localDateFields("2026-02-30"), { code: "INVALID_ARGUMENT" });
});

test("deleteTimeEntry rejects a stale snapshot before DELETE", async () => {
  let deletes = 0;
  const client = { async request(path, options = {}) {
    if (path.endsWith("/time_entries/9") && !options.method) return { time_entry: { id: 9, is_logged: true, duration: 60, started_at: "2026-09-02T12:00:00Z" } };
    if (options.method === "DELETE") deletes += 1;
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore });
  await assert.rejects(service.deleteTimeEntry(9, { snapshotToken: "stale" }), { code: "REMOTE_CHANGED" });
  assert.equal(deletes, 0);
});

test("logged entries derive client and billability from the selected project service", async () => {
  let written;
  const client = { async request(path, options = {}) {
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/comments/business/123/project/44") return {
      project: { id: 44, client_id: 55, internal: false, active: true, complete: false, services: [{ id: 66, billable: true }] },
      abilities: [{ name: "can_track_time", value: true }],
    };
    if (path === "/timetracking/business/123/time_entries" && options.method === "POST") {
      written = options.body.time_entry;
      return { time_entry: { id: 9, ...written } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore });
  const result = await service.createTimeEntry({
    is_logged: true, duration: 60, started_at: "2026-09-02T12:00:00Z", project_id: 44, service_id: 66,
  });
  assert.equal(written.client_id, 55);
  assert.equal(written.billable, true);
  assert.equal(result.projectId, 44);
  assert.equal(result.clientId, 55);
  assert.equal(result.billable, true);
  assert.match(result.snapshotToken, /^[a-f0-9]{64}$/);
});

test("internal project time remains non-billable even when its service is billable", async () => {
  let written;
  const client = { async request(path, options = {}) {
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/comments/business/123/project/44") return {
      project: { id: 44, client_id: null, internal: true, active: true, complete: false, services: [{ id: 66, billable: true }] },
      abilities: [{ name: "can_track_time", value: true }],
    };
    if (path === "/timetracking/business/123/time_entries" && options.method === "POST") {
      written = options.body.time_entry;
      return { time_entry: { id: 9, ...written } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore });
  await service.createTimeEntry({ is_logged: true, duration: 60, started_at: "2026-09-02T12:00:00Z", project_id: 44, service_id: 66 });
  assert.equal(written.billable, false);
  assert.equal(written.internal, true);
});

test("startTimer creates a timer identity then assigns project metadata", async () => {
  const requests = [];
  let assigned;
  const client = { async request(path, options = {}) {
    requests.push({ path, ...options });
    if (path.includes("/time_entries") && !options.method) return { time_entries: assigned ? [assigned] : [] };
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/comments/business/123/project/44") return { project: { id: 44, client_id: 55, active: true, complete: false, services: [{ id: 66, billable: true }] }, abilities: [{ name: "can_track_time", value: true }] };
    if (path === "/comments/business/123/time_entries" && options.method === "POST") return { time_entry: { id: 900, ...options.body.time_entry, timer: { id: 901 } } };
    if (path === "/comments/business/123/time_entries/900" && options.method === "PUT") {
      assigned = segment({ ...options.body.time_entry });
      return { time_entry: assigned };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now });
  const timer = await service.startTimer({ project_id: 44, service_id: 66, note: "Build shell plugin" });
  const create = requests.find((request) => request.path === "/comments/business/123/time_entries" && request.method === "POST");
  const assign = requests.find((request) => request.path.endsWith("/time_entries/900"));
  assert.deepEqual(create.body.time_entry.timer, {});
  assert.equal(create.body.time_entry.duration, null);
  assert.equal(create.body.time_entry.project_id, null);
  assert.deepEqual(assign.body.time_entry.timer, { id: 901 });
  assert.equal(assign.body.time_entry.project_id, 44);
  assert.equal(assign.body.time_entry.service_id, 66);
  assert.equal(assign.body.time_entry.billable, true);
  assert.equal(assign.body.time_entry.local_timezone, "America/Chicago");
  assert.equal(timer.id, 901);
  assert.deepEqual(timer.segmentIds, [900]);
});

test("pause closes the open segment and resume appends a segment", async () => {
  const requests = [];
  let entries = [segment()];
  const client = { async request(path, options = {}) {
    requests.push({ path, ...options });
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/time_entries/900" && options.method === "PUT") {
      entries = [{ ...entries[0], ...options.body.time_entry, timer: { id: 901, is_running: false } }];
      return { time_entry: entries[0] };
    }
    if (path === "/comments/business/123/time_entries" && options.method === "POST") {
      entries.push(segment({ id: 902, ...options.body.time_entry, timer: { id: 901, is_running: true } }));
      return { time_entry: entries[1] };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now });
  const paused = await service.pauseTimer(901);
  assert.equal(paused.running, false);
  assert.equal(paused.elapsedSeconds, 60);
  const pause = requests.find((request) => request.method === "PUT");
  assert.equal(pause.body.time_entry.duration, 60);
  assert.equal(pause.body.time_entry.timer.is_running, undefined);
  const resumed = await service.resumeTimer(901);
  assert.equal(resumed.running, true);
  assert.deepEqual(resumed.segmentIds, [900, 902]);
  const resume = requests.find((request) => request.method === "POST");
  assert.deepEqual(resume.body.time_entry.timer, { id: 901 });
  assert.equal(resume.body.time_entry.duration, null);
});

test("timer mutations reject stale snapshots before writing", async () => {
  let writes = 0;
  const client = { async request(path, options = {}) {
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/timetracking/business/123/time_entries") return { time_entries: [segment()] };
    if (options.method) writes += 1;
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now });
  await assert.rejects(service.pauseTimer(901, { snapshotToken: "stale" }), { code: "REMOTE_CHANGED" });
  assert.equal(writes, 0);
});

test("running correction preserves closed duration and rebases the open segment", async () => {
  const requests = [];
  let entries = [segment({ id: 900, duration: 57, started_at: "2026-09-01T14:00:00Z" }), segment({ id: 902 })];
  const client = { async request(path, options = {}) {
    requests.push({ path, ...options });
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (options.method === "PUT") {
      const id = Number(path.split("/").at(-1));
      entries = entries.map((entry) => entry.id === id ? { ...entry, ...options.body.time_entry } : entry);
      return { time_entry: entries.find((entry) => entry.id === id) };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now });
  const corrected = await service.correctTimer(901, 600);
  assert.equal(corrected.elapsedSeconds, 600);
  assert.equal(entries[0].duration, 57);
  assert.equal(entries[1].started_at, "2026-09-01T14:50:57.000Z");
  assert.equal(requests.filter((request) => request.method === "PUT").length, 2);
});

test("logTimer preflights the project and PUTs the logical timer resource", async () => {
  const requests = [];
  const entries = [segment({ duration: 60, timer: { id: 901, is_running: false } })];
  const client = { async request(path, options = {}) {
    requests.push({ path, ...options });
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/project/44") return { project: { id: 44, active: true, complete: false, services: [{ id: 66, billable: true }] }, abilities: [{ name: "can_track_time", value: true }] };
    if (path === "/comments/business/123/timers/901" && options.method === "PUT") return { time_entry: { id: 903, is_logged: true, duration: 60 } };
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now });
  const logged = await service.logTimer(901);
  const update = requests.find((request) => request.path.endsWith("/timers/901"));
  assert.equal(update.body.timer.time_entries.length, 1);
  assert.equal(update.body.timer.time_entries[0].is_logged, false);
  assert.equal(logged.timerId, 901);
  assert.equal(logged.elapsedSeconds, 60);
});

test("activeTimers makes one identity-scoped bounded request instead of paginating history", async () => {
  let requests = 0;
  let query;
  const client = { async request(path, options = {}) {
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path.includes("/time_entries")) { requests += 1; query = options.query; return { time_entries: [], meta: { page: 1, pages: 500 } }; }
    throw new Error(`Unexpected request: ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore });
  assert.deepEqual(await service.activeTimers(), []);
  assert.equal(requests, 1);
  assert.equal(query.identity_id, 88);
  assert.equal(query.per_page, 100);
});

test("recent time-entry history stops at the requested bound", async () => {
  const pages = [];
  const client = { async request(path, options = {}) {
    if (!path.endsWith("/time_entries")) throw new Error(`Unexpected request: ${path}`);
    pages.push(options.query.page);
    const start = (options.query.page - 1) * 100;
    return {
      time_entries: Array.from({ length: 100 }, (_, index) => ({
        id: start + index + 1, is_logged: true, duration: 1, started_at: "2026-09-02T12:00:00Z",
      })),
      meta: { pages: 500 },
    };
  } };
  const service = new FreshBooksService({ client, configStore });
  const entries = await service.timeEntryRecords({ sort: "started_at_desc" }, { limit: 200 });
  assert.equal(entries.length, 200);
  assert.deepEqual(pages, [1, 2]);
});

test("timer switch validates the target before logging current work", async () => {
  let timerWrites = 0;
  const client = { async request(path, options = {}) {
    if (path === "/comments/business/123/project/99") return {
      project: { id: 99, active: false, complete: false, services: [{ id: 77, billable: true }] },
      abilities: [{ name: "can_track_time", value: true }],
    };
    if (path.includes("/timers/") && options.method === "PUT") timerWrites += 1;
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now });
  await assert.rejects(service.switchTimer(901, { project_id: 99, service_id: 77 }), { code: "PROJECT_NOT_ACTIVE" });
  assert.equal(timerWrites, 0);
});
