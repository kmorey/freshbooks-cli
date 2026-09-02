import test from "node:test";
import assert from "node:assert/strict";
import { FreshBooksService, groupTimerSegments, presentTimeEntry } from "../src/freshbooks.js";

const businessId = 123;
const now = () => new Date("2026-09-01T15:00:00Z");
const configStore = { async read() { return { businessId }; }, async update() {} };

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
  assert.deepEqual(presentTimeEntry({ id: 9, is_logged: true, started_at: "2026-09-02T12:00:00Z", duration: 90, project_id: 44, note: "Work" }), {
    id: 9, startedAt: "2026-09-02T12:00:00Z", localStartedAt: null, localDate: "2026-09-02",
    durationSeconds: 90, projectId: 44, clientId: null, serviceId: null, note: "Work", billable: false, billed: false,
  });
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
  assert.equal(timer.id, 901);
  assert.deepEqual(timer.segmentIds, [900]);
});

test("pause closes the open segment and resume appends a segment", async () => {
  const requests = [];
  let entries = [segment()];
  const client = { async request(path, options = {}) {
    requests.push({ path, ...options });
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

test("running correction preserves closed duration and rebases the open segment", async () => {
  const requests = [];
  let entries = [segment({ id: 900, duration: 57, started_at: "2026-09-01T14:00:00Z" }), segment({ id: 902 })];
  const client = { async request(path, options = {}) {
    requests.push({ path, ...options });
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

test("activeTimers makes one bounded request instead of paginating history", async () => {
  let requests = 0;
  const client = { async request(path) {
    if (path.includes("/time_entries")) { requests += 1; return { time_entries: [], meta: { page: 1, pages: 500 } }; }
    throw new Error(`Unexpected request: ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore });
  assert.deepEqual(await service.activeTimers(), []);
  assert.equal(requests, 1);
});
