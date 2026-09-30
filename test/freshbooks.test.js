import test from "node:test";
import assert from "node:assert/strict";
import { FreshBooksService, groupTimerSegments, presentTimeEntry } from "../src/freshbooks.js";
import { TrackingContext } from "../src/tracking.js";
import { run } from "../src/cli.js";

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

function sink() {
  return { value: "", write(chunk) { this.value += chunk; } };
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

test("includes a logged entry in the total when its timer is being continued", () => {
  const timers = groupTimerSegments([
    segment({ id: 1, is_logged: true, duration: 7200, started_at: "2026-09-01T12:00:00Z", timer: { id: 901, is_running: false } }),
    segment({ id: 2, duration: null, started_at: "2026-09-01T14:59:00Z" }),
  ], now());

  assert.equal(timers.length, 1);
  assert.equal(timers[0].elapsedSeconds, 7260);
  assert.equal(timers[0].continuedSeconds, 7200);
  assert.deepEqual(timers[0].segmentIds, [1, 2]);
  assert.deepEqual(timers[0].activeSegmentIds, [2]);
  assert.equal(timers[0].segments[0].isLogged, true);
  assert.equal(timers[0].segments[1].isLogged, false);
});

test("does not surface a timer after all of its entries are logged", () => {
  const timers = groupTimerSegments([
    segment({ id: 1, is_logged: true, duration: 7200, timer: { id: 901, is_running: false } }),
  ], now());

  assert.deepEqual(timers, []);
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

test("running correction treats a logged continuation predecessor as immutable", async () => {
  const requests = [];
  let entries = [
    segment({ id: 899, is_logged: true, duration: 300, started_at: "2026-09-01T14:00:00Z", timer: { id: 901, is_running: false } }),
    segment({ id: 900, duration: null, started_at: "2026-09-01T14:59:00Z" }),
  ];
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
  assert.equal(entries[0].duration, 300);
  assert.equal(entries[1].started_at, "2026-09-01T14:55:00.000Z");
  assert.equal(requests.filter((request) => request.method === "PUT").length, 1);
});

test("logTimer preflights the project and PUTs the logical timer resource", async () => {
  const requests = [];
  const entries = [
    segment({ id: 899, is_logged: true, duration: 7200, started_at: "2026-09-01T12:00:00Z", timer: { id: 901, is_running: false } }),
    segment({ id: 900, duration: 60, timer: { id: 901, is_running: false } }),
  ];
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
  assert.equal(update.body.timer.time_entries[0].id, undefined);
  assert.equal(update.body.timer.time_entries[0].is_logged, false);
  assert.equal(logged.timerId, 901);
  assert.equal(logged.elapsedSeconds, 7260);
});

test("activeTimers omits the identity filter FreshBooks rejects while keeping polling bounded", async () => {
  let requests = 0;
  let query;
  const client = { async request(path, options = {}) {
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path.includes("/time_entries")) {
      requests += 1;
      query = options.query;
      if (query.identity_id !== undefined) throw new Error("FreshBooks API returned HTTP 422");
      return { time_entries: [], meta: { page: 1, pages: 500 } };
    }
    throw new Error(`Unexpected request: ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore });
  assert.deepEqual(await service.activeTimers(), []);
  assert.equal(requests, 1);
  assert.equal(query.identity_id, undefined);
  assert.equal(query.include_unlogged, true);
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

test("time list returns a canonical observation with exact date coverage", async () => {
  const client = { async request(path) {
    if (path === "/timetracking/business/123/time_entries") {
      return {
        time_entries: [{
          id: 9,
          is_logged: true,
          started_at: "2026-09-02T12:00:00Z",
          duration: 90,
          project_id: 44,
          note: "Work",
        }],
        meta: { pages: 1 },
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  } };
  const context = new TrackingContext({
    timezone: "America/Chicago",
    observedAt: "2026-09-02T12:01:30Z",
  });
  const service = new FreshBooksService({ client, configStore }).withTracking(context);

  const observation = await service.timeEntryObservation(
    { started_from: "2026-09-01T05:00:00.000Z", started_to: "2026-10-01T04:59:59.999Z" },
    { coverage: { complete: true, fromDate: "2026-09-01", toDate: "2026-09-30" } },
  );

  assert.equal(observation.contractVersion, 2);
  assert.deepEqual(observation.coverage, {
    complete: true,
    includesDeleted: false,
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
  });
  assert.equal(observation.records[0].kind, "time-entry");
  assert.equal(observation.records[0].id, "9");
  assert.equal(observation.records[0].durationSeconds, 90);
  assert.equal(observation.records[0].snapshotToken, undefined);
  assert.equal(context.get("time-entry:9"), observation.records[0]);
});

test("timer status returns complete canonical active timers without display fields", async () => {
  const client = { async request(path) {
    if (path === "/timetracking/business/123/time_entries") {
      return { time_entries: [segment()], meta: { pages: 1 } };
    }
    throw new Error(`Unexpected request: ${path}`);
  } };
  const context = new TrackingContext({
    timezone: "America/Chicago",
    observedAt: "2026-09-01T15:00:00Z",
  });
  const service = new FreshBooksService({ client, configStore, now }).withTracking(context);

  const observation = await service.timerStatusObservation();

  assert.equal(observation.contractVersion, 2);
  assert.equal(observation.queryKey, "timer-status");
  assert.deepEqual(observation.coverage, {
    complete: true,
    includesDeleted: false,
    fromDate: null,
    toDate: null,
  });
  assert.equal(observation.records[0].kind, "active-timer");
  assert.equal(observation.records[0].id, "901");
  assert.equal(observation.records[0].state, "running");
  assert.equal(observation.records[0].elapsed, undefined);
  assert.equal(observation.records[0].snapshotToken, undefined);
  assert.equal(context.get("active-timer:901"), observation.records[0]);
});

test("run creates command-scoped contexts for canonical read output", async () => {
  const client = { async request(path, options = {}) {
    if (path !== "/timetracking/business/123/time_entries") {
      throw new Error(`Unexpected request: ${path}`);
    }
    if (options.query.include_unlogged === true) {
      return { time_entries: [segment()] };
    }
    return {
      time_entries: [{
        id: 9,
        is_logged: true,
        started_at: "2026-09-02T12:00:00Z",
        duration: 90,
        note: "Work",
      }],
      meta: { pages: 1 },
    };
  } };
  const secretStore = {};
  const timeStdout = sink();
  const timerStdout = sink();

  assert.equal(await run([
    "time", "list", "--from", "2026-09-01", "--to", "2026-09-30", "--json",
  ], {
    client,
    configStore,
    secretStore,
    now,
    stdout: timeStdout,
    stderr: sink(),
  }), 0);
  assert.equal(await run(["timer", "status", "--json"], {
    client,
    configStore,
    secretStore,
    now,
    stdout: timerStdout,
    stderr: sink(),
  }), 0);

  const timeData = JSON.parse(timeStdout.value).data;
  const timerData = JSON.parse(timerStdout.value).data;
  assert.equal(timeData.contractVersion, 2);
  assert.deepEqual(timeData.coverage, {
    complete: true,
    includesDeleted: false,
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
  });
  assert.equal(timeData.records[0].id, "9");
  assert.equal(timerData.contractVersion, 2);
  assert.equal(timerData.queryKey, "timer-status");
  assert.equal(timerData.records[0].id, "901");
});

test("timer status reads later pages before claiming complete coverage", async () => {
  const pages = [];
  const client = { async request(path, options = {}) {
    if (path !== "/timetracking/business/123/time_entries") {
      throw new Error(`Unexpected request: ${path}`);
    }
    pages.push(options.query.page);
    return options.query.page === 1
      ? { time_entries: [], meta: { pages: 2 } }
      : { time_entries: [segment()], meta: { pages: 2 } };
  } };
  const context = new TrackingContext({
    timezone: "America/Chicago",
    observedAt: "2026-09-01T15:00:00Z",
  });
  const service = new FreshBooksService({ client, configStore, now }).withTracking(context);

  const observation = await service.timerStatusObservation();

  assert.deepEqual(pages, [1, 2]);
  assert.equal(observation.coverage.complete, true);
  assert.equal(observation.records[0].id, "901");
});

test("overlapping runs keep independent tracking contexts on one injected service", async () => {
  const pending = [];
  const started = [];
  const client = { request() {
    return new Promise((resolve) => {
      pending.push(resolve);
      started.shift()?.();
    });
  } };
  const serviceConfig = {
    async read() { return { businessId, timezone: "UTC" }; },
  };
  const service = new FreshBooksService({ client, configStore: serviceConfig, now });
  const firstStarted = new Promise((resolve) => started.push(resolve));
  const firstStdout = sink();
  const firstRun = run(["time", "list", "--json"], {
    service,
    configStore: { async read() { return { timezone: "America/Chicago" }; } },
    secretStore: {},
    now,
    stdout: firstStdout,
    stderr: sink(),
  });
  await firstStarted;

  const secondStarted = new Promise((resolve) => started.push(resolve));
  const secondStdout = sink();
  const secondRun = run(["time", "list", "--json"], {
    service,
    configStore: { async read() { return { timezone: "UTC" }; } },
    secretStore: {},
    now,
    stdout: secondStdout,
    stderr: sink(),
  });
  await secondStarted;

  const response = {
    time_entries: [{
      id: 9,
      is_logged: true,
      started_at: "2026-09-02T02:00:00Z",
      duration: 90,
    }],
    meta: { pages: 1 },
  };
  pending[1](response);
  assert.equal(await secondRun, 0);
  pending[0](response);
  assert.equal(await firstRun, 0);

  assert.equal(JSON.parse(firstStdout.value).data.records[0].localDate, "2026-09-01");
  assert.equal(JSON.parse(secondStdout.value).data.records[0].localDate, "2026-09-02");
});

test("local usage errors do not read configuration to create tracking context", async () => {
  let configReads = 0;
  const stdout = sink();
  const stderr = sink();

  assert.equal(await run(["time", "delete", "--json"], {
    service: new FreshBooksService({ client: {}, configStore }),
    configStore: {
      async read() {
        configReads += 1;
        throw new Error("configuration should not be read");
      },
    },
    secretStore: {},
    stdout,
    stderr,
  }), 2);

  assert.equal(configReads, 0);
  assert.match(JSON.parse(stderr.value).error.message, /Usage: freshbooks time delete/);
});
