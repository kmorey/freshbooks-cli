import test from "node:test";
import assert from "node:assert/strict";
import { FreshBooksService, groupTimerSegments, presentTimeEntry } from "../src/freshbooks.js";
import { TrackingContext, canonicalTimeEntry } from "../src/tracking.js";
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

function trackingContext() {
  return new TrackingContext({
    timezone: "America/Chicago",
    observedAt: "2026-09-01T15:00:00Z",
  });
}

async function currentTimerGuard(service, timerId = 901) {
  await service.activeTimers();
  return service.trackingContext.get(`active-timer:${timerId}`).token;
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
  const normalized = presentTimeEntry({
    id: 9,
    is_logged: true,
    started_at: "2026-09-02T12:00:00Z",
    duration: 90,
    project_id: 44,
    note: "Work",
  });
  assert.deepEqual(normalized, {
    id: 9, startedAt: "2026-09-02T12:00:00Z", localStartedAt: null, localDate: "2026-09-02",
    durationSeconds: 90, projectId: 44, clientId: null, serviceId: null, note: "Work", billable: false, billed: false,
  });
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

test("existing-record mutations require guards before writing", async () => {
  let writes = 0;
  const timeClient = { async request(path, options = {}) {
    if (path.endsWith("/time_entries/9") && !options.method) {
      return { time_entry: {
        id: 9,
        is_logged: true,
        duration: 60,
        started_at: "2026-09-02T12:00:00Z",
      } };
    }
    if (options.method) {
      writes += 1;
      return {};
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const timerClient = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: [segment()] };
    if (options.method) {
      writes += 1;
      return {};
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const switchClient = { async request(path, options = {}) {
    if (path === "/comments/business/123/project/44") {
      return {
        project: {
          id: 44,
          active: true,
          complete: false,
          services: [{ id: 66, billable: true }],
        },
        abilities: [{ name: "can_track_time", value: true }],
      };
    }
    if (path === "/timetracking/business/123/time_entries") return { time_entries: [] };
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (options.method) writes += 1;
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };

  await assert.rejects(
    new FreshBooksService({ client: timeClient, configStore }).deleteTimeEntry(9),
    { code: "GUARD_REQUIRED" },
  );
  await assert.rejects(
    new FreshBooksService({ client: timerClient, configStore, now }).pauseTimer(901),
    { code: "GUARD_REQUIRED" },
  );
  await assert.rejects(
    new FreshBooksService({ client: switchClient, configStore, now }).switchTimer(
      901,
      { project_id: 44, service_id: 66 },
    ),
    { code: "GUARD_REQUIRED" },
  );
  assert.equal(writes, 0);
});

test("guard rejection returns complete canonical current state without writing", async () => {
  let writes = 0;
  const client = { async request(path, options = {}) {
    if (path.endsWith("/time_entries/9") && !options.method) {
      return { time_entry: {
        id: 9,
        is_logged: true,
        duration: 60,
        started_at: "2026-09-02T12:00:00Z",
        project_id: 44,
        client_id: 55,
        service_id: 66,
        note: "Current work",
        billable: true,
        billed: false,
      } };
    }
    if (options.method) writes += 1;
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const context = new TrackingContext({
    timezone: "America/Chicago",
    observedAt: "2026-09-02T12:01:30Z",
  });
  const service = new FreshBooksService({ client, configStore }).withTracking(context);

  await assert.rejects(
    service.deleteTimeEntry(9, { guard: "stale" }),
    (error) => {
      assert.equal(error.code, "GUARD_REJECTED");
      assert.equal(error.details.expectedToken, "stale");
      assert.match(error.details.currentToken, /^[a-f0-9]{64}$/);
      assert.deepEqual(error.details.current, {
        contractVersion: 2,
        kind: "time-entry",
        id: "9",
        exists: true,
        localDate: "2026-09-02",
        startedAt: "2026-09-02T12:00:00.000Z",
        durationSeconds: 60,
        projectId: "44",
        clientId: "55",
        serviceId: "66",
        note: "Current work",
        billable: true,
        billed: false,
        token: error.details.currentToken,
      });
      assert.deepEqual(error.details.identity, { kind: "time-entry", id: "9" });
      return true;
    },
  );
  assert.equal(writes, 0);
});

test("time entry create receipt marks assigned identity absent before", async () => {
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries" && options.method === "POST") {
      return { time_entry: { id: 9, ...options.body.time_entry } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const context = trackingContext();
  const service = new FreshBooksService({ client, configStore }).withTracking(context);

  const result = await service.createTimeEntry({
    identity_id: 88,
    is_logged: true,
    duration: 60,
    started_at: "2026-09-02T12:00:00Z",
    project_id: null,
    client_id: null,
    service_id: null,
    note: "Created",
    billable: false,
    billed: false,
  });
  const created = canonicalTimeEntry({
    id: 9,
    is_logged: true,
    identity_id: 88,
    duration: 60,
    started_at: "2026-09-02T12:00:00Z",
    project_id: null,
    client_id: null,
    service_id: null,
    note: "Created",
    billable: false,
    billed: false,
  }, { timezone: context.timezone });

  assert.deepEqual(result, {
    contractVersion: 2,
    mutationKind: "time-entry-create",
    changes: [{
      scope: "time-entry:9",
      before: { absent: true },
      after: { record: created },
    }],
    results: [created],
    phase: null,
  });
  assert.equal(result.kind, undefined);
  assert.equal(context.get("time-entry:9"), result.results[0]);
});

test("update receipt carries before and after tokens", async () => {
  let reads = 0;
  const beforePayload = {
    id: 9,
    is_logged: true,
    duration: 60,
    started_at: "2026-09-02T12:00:00Z",
    project_id: 44,
    client_id: 55,
    service_id: 66,
    note: "Before",
    billable: true,
    billed: false,
  };
  const client = { async request(path, options = {}) {
    if (path.endsWith("/time_entries/9") && !options.method) {
      reads += 1;
      return { time_entry: beforePayload };
    }
    if (path.endsWith("/time_entries/9") && options.method === "PUT") {
      return { time_entry: { ...beforePayload, ...options.body.time_entry, note: "After" } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const context = trackingContext();
  const before = canonicalTimeEntry(beforePayload, { timezone: context.timezone });
  const service = new FreshBooksService({ client, configStore }).withTracking(context);

  const result = await service.updateTimeEntry(9, { note: "After" }, { guard: before.token });

  assert.equal(reads, 1);
  assert.equal(result.mutationKind, "time-entry-update");
  assert.equal(result.kind, undefined);
  assert.equal(result.changes[0].scope, "time-entry:9");
  assert.deepEqual(result.changes[0].before, { token: before.token });
  assert.equal(result.changes[0].after.record.note, "After");
  assert.notEqual(result.changes[0].after.record.token, before.token);
  assert.equal(result.results[0], result.changes[0].after.record);
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
  assert.equal(result.mutationKind, "time-entry-create");
  assert.equal(result.kind, undefined);
  assert.equal(result.changes[0].scope, "time-entry:9");
  assert.deepEqual(result.changes[0].before, { absent: true });
  assert.equal(result.results[0].projectId, "44");
  assert.equal(result.results[0].clientId, "55");
  assert.equal(result.results[0].billable, true);
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
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());
  const result = await service.startTimer({ project_id: 44, service_id: 66, note: "Build shell plugin" });
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
  assert.equal(result.results[0].id, "901");
  assert.deepEqual(result.results[0].segments.map((item) => item.id), ["900"]);
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
  const context = trackingContext();
  const service = new FreshBooksService({ client, configStore, now }).withTracking(context);
  const paused = await service.pauseTimer(901, {
    guard: await currentTimerGuard(service),
  });
  assert.equal(paused.results[0].state, "paused");
  assert.equal(paused.results[0].elapsedAnchor.closedSeconds, 60);
  const pause = requests.find((request) => request.method === "PUT");
  assert.equal(pause.body.time_entry.duration, 60);
  assert.equal(pause.body.time_entry.timer.is_running, undefined);
  const resumed = await service.resumeTimer(901, {
    guard: context.get("active-timer:901").token,
  });
  assert.equal(resumed.results[0].state, "running");
  assert.deepEqual(resumed.results[0].segments.map((item) => item.id), ["900", "902"]);
  const resume = requests.find((request) => request.method === "POST");
  assert.deepEqual(resume.body.time_entry.timer, { id: 901 });
  assert.equal(resume.body.time_entry.duration, null);
});

test("timer mutations reject stale guards before writing", async () => {
  let writes = 0;
  const client = { async request(path, options = {}) {
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/timetracking/business/123/time_entries") return { time_entries: [segment()] };
    if (options.method) writes += 1;
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const context = new TrackingContext({
    timezone: "America/Chicago",
    observedAt: "2026-09-01T15:00:00Z",
  });
  const service = new FreshBooksService({ client, configStore, now }).withTracking(context);
  await assert.rejects(
    service.pauseTimer(901, { guard: "stale" }),
    (error) => {
      assert.equal(error.code, "GUARD_REJECTED");
      assert.equal(error.details.expectedToken, "stale");
      assert.match(error.details.currentToken, /^[a-f0-9]{64}$/);
      assert.equal(error.details.current.kind, "active-timer");
      assert.equal(error.details.current.id, "901");
      assert.equal(error.details.current.token, error.details.currentToken);
      return true;
    },
  );
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
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());
  const corrected = await service.correctTimer(901, 600, {
    guard: await currentTimerGuard(service),
  });
  assert.equal(corrected.results[0].elapsedAnchor.closedSeconds, 57);
  assert.equal(corrected.results[0].elapsedAnchor.runningStartedAt, "2026-09-01T14:50:57.000Z");
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
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());

  const corrected = await service.correctTimer(901, 600, {
    guard: await currentTimerGuard(service),
  });

  assert.equal(corrected.results[0].elapsedAnchor.closedSeconds, 300);
  assert.equal(corrected.results[0].elapsedAnchor.runningStartedAt, "2026-09-01T14:55:00.000Z");
  assert.equal(entries[0].duration, 300);
  assert.equal(entries[1].started_at, "2026-09-01T14:55:00.000Z");
  assert.equal(requests.filter((request) => request.method === "PUT").length, 1);
});

test("logTimer pauses a running timer before logging its timer resource", async () => {
  const requests = [];
  let entries = [
    segment({ id: 899, is_logged: true, duration: 7200, started_at: "2026-09-01T12:00:00Z", timer: { id: 901, is_running: false } }),
    segment({ id: 900 }),
  ];
  const client = { async request(path, options = {}) {
    requests.push({ path, ...options });
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/project/44") return { project: { id: 44, active: true, complete: false, services: [{ id: 66, billable: true }] }, abilities: [{ name: "can_track_time", value: true }] };
    if (path === "/comments/business/123/time_entries/900" && options.method === "PUT") {
      entries = entries.map((entry) => entry.id === 900
        ? { ...entry, ...options.body.time_entry, timer: { id: 901, is_running: false } }
        : entry);
      return { time_entry: entries.find((entry) => entry.id === 900) };
    }
    if (path === "/comments/business/123/timers/901" && options.method === "PUT") {
      assert.notEqual(entries.find((entry) => entry.id === 900).duration, null);
      return { timer: { time_entries: [{
        id: 903,
        is_logged: true,
        duration: 7260,
        started_at: "2026-09-01T12:00:00Z",
        project_id: 44,
        client_id: 55,
        service_id: 66,
        note: "Build shell plugin",
        billable: true,
        billed: false,
      }] } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());
  const logged = await service.logTimer(901, {
    guard: await currentTimerGuard(service),
  });
  const writes = requests.filter((request) => request.method === "PUT");
  assert.deepEqual(writes.map((request) => request.path), [
    "/comments/business/123/time_entries/900",
    "/comments/business/123/timers/901",
  ]);
  assert.equal(writes[1].body.timer.time_entries.length, 1);
  assert.equal(writes[1].body.timer.time_entries[0].id, undefined);
  assert.equal(writes[1].body.timer.time_entries[0].is_logged, false);
  assert.equal(logged.results[0].id, "903");
  assert.equal(logged.results[0].durationSeconds, 7260);
});

test("logTimer rejects a response that retains an unlogged timer segment", async () => {
  const entries = [segment({
    duration: 60,
    note: "",
    timer: { id: 901, is_running: false },
  })];
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/project/44") {
      return {
        project: { id: 44, active: true, complete: false, services: [{ id: 66, billable: true }] },
        abilities: [{ name: "can_track_time", value: true }],
      };
    }
    if (path === "/comments/business/123/timers/901" && options.method === "PUT") {
      return { timer: { time_entries: entries } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());

  await assert.rejects(
    service.logTimer(901, { guard: await currentTimerGuard(service) }),
    error => error.code === "MUTATION_OUTCOME_UNKNOWN"
      && error.outcomeUnknown === true
      && error.details.mutationKind === "timer-log"
      && error.details.cause.code === "UNCONFIRMED_TIMER_LOG",
  );
});

test("switchTimer does not start the next timer after an unconfirmed log response", async () => {
  const entries = [segment({
    duration: 60,
    note: "",
    timer: { id: 901, is_running: false },
  })];
  let starts = 0;
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/project/99") {
      return {
        project: { id: 99, active: true, complete: false, services: [{ id: 77, billable: false }] },
        abilities: [{ name: "can_track_time", value: true }],
      };
    }
    if (path === "/comments/business/123/timers/901" && options.method === "PUT") {
      return { timer: { time_entries: entries } };
    }
    if (path === "/comments/business/123/time_entries" && options.method === "POST") {
      starts += 1;
      throw new Error("Next timer must not start");
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());

  await assert.rejects(
    service.switchTimer(
      901,
      { project_id: 99, service_id: 77, note: "" },
      { guard: await currentTimerGuard(service) },
    ),
    error => error.code === "MUTATION_OUTCOME_UNKNOWN"
      && error.outcomeUnknown === true
      && error.details.mutationKind === "timer-switch",
  );
  assert.equal(starts, 0);
});

test("logTimer selects the confirmed aggregate instead of an unrelated last entry", async () => {
  const entries = [
    segment({
      id: 899,
      is_logged: true,
      duration: 120,
      note: "",
      started_at: "2026-09-01T14:57:00Z",
      timer: { id: 901, is_running: false },
    }),
    segment({
      id: 900,
      duration: 60,
      note: "",
      timer: { id: 901, is_running: false },
    }),
  ];
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/project/44") {
      return {
        project: { id: 44, active: true, complete: false, services: [{ id: 66, billable: true }] },
        abilities: [{ name: "can_track_time", value: true }],
      };
    }
    if (path === "/comments/business/123/timers/901" && options.method === "PUT") {
      return { timer: { time_entries: [{
        id: 903,
        is_logged: true,
        duration: 180,
        started_at: "2026-09-01T14:57:00Z",
        project_id: 44,
        client_id: 55,
        service_id: 66,
        note: "",
        billable: true,
        billed: false,
      }, {
        id: 999,
        is_logged: true,
        duration: 1,
        started_at: "2020-01-01T00:00:00Z",
      }] } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());

  const result = await service.logTimer(901, { guard: await currentTimerGuard(service) });

  assert.equal(result.results[0].id, "903");
  assert.equal(result.results[0].durationSeconds, 180);
  assert.equal(result.results[1].kind, "active-timer");
  assert.equal(result.results[1].exists, false);
});

test("timer start returns assigned receipt", async () => {
  let entries = [];
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/comments/business/123/project/44") return {
      project: { id: 44, client_id: 55, active: true, complete: false, services: [{ id: 66, billable: true }] },
      abilities: [{ name: "can_track_time", value: true }],
    };
    if (path === "/comments/business/123/time_entries" && options.method === "POST") {
      return { time_entry: { id: 900, timer: { id: 901 } } };
    }
    if (path === "/comments/business/123/time_entries/900" && options.method === "PUT") {
      entries = [{ id: 900, ...options.body.time_entry }];
      return { time_entry: entries[0] };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const context = trackingContext();
  const service = new FreshBooksService({ client, configStore, now }).withTracking(context);

  const result = await service.startTimer({ project_id: 44, service_id: 66, note: "Build shell plugin" });

  assert.equal(result.mutationKind, "timer-start");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].kind, "active-timer");
  assert.equal(result.results[0].id, "901");
  assert.deepEqual(result.changes, [{
    scope: "active-timer:901",
    before: { absent: true },
    after: { record: result.results[0] },
  }]);
  assert.equal(result.phase, null);
  assert.equal(context.get("active-timer:901"), result.results[0]);
});

test("timer start reports unknown after assignment write fails", async () => {
  let created = false;
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: [] };
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/comments/business/123/project/44") return {
      project: { id: 44, client_id: 55, active: true, complete: false, services: [{ id: 66, billable: true }] },
      abilities: [{ name: "can_track_time", value: true }],
    };
    if (path === "/comments/business/123/time_entries" && options.method === "POST") {
      created = true;
      return { time_entry: { id: 900, timer: { id: 901 } } };
    }
    if (path === "/comments/business/123/time_entries/900" && options.method === "PUT")
      throw new Error("assignment failed");
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());

  await assert.rejects(
    service.startTimer({ project_id: 44, service_id: 66 }),
    error => created && error.code === "MUTATION_OUTCOME_UNKNOWN" && error.outcomeUnknown === true,
  );
});

test("multi-segment correction and update report unknown after a confirmed write", async () => {
  for (const operation of ["correct", "update"]) {
    let writes = 0;
    const entries = [
      segment({ id: 900, duration: 30, timer: { id: 901, is_running: false } }),
      segment({ id: 902, duration: null, timer: { id: 901, is_running: true } }),
    ];
    const client = { async request(path, options = {}) {
      if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
      if (path.startsWith("/comments/business/123/time_entries/") && options.method === "PUT") {
        writes += 1;
        if (writes === 2) throw new Error("second segment failed");
        return { time_entry: { ...entries[0], ...options.body.time_entry } };
      }
      throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
    } };
    const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());
    const guard = await currentTimerGuard(service);
    const call = operation === "correct"
      ? service.correctTimer(901, 120, { guard })
      : service.updateTimer(901, { note: "Updated" }, { guard });
    await assert.rejects(
      call,
      error => writes === 2 && error.code === "MUTATION_OUTCOME_UNKNOWN" && error.outcomeUnknown === true,
    );
  }
});

test("multi-segment discard reports unknown after a confirmed delete", async () => {
  let deletes = 0;
  const entries = [
    segment({ id: 910, duration: 30, timer: { id: 911, is_running: false } }),
    segment({ id: 912, timer: { id: 911, is_running: true } }),
  ];
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path.startsWith("/timetracking/business/123/time_entries/") && options.method === "DELETE") {
      deletes += 1;
      if (deletes === 2) throw new Error("second delete failed");
      return {};
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());
  const guard = await currentTimerGuard(service, 911);

  await assert.rejects(
    service.discardTimer(911, { guard }),
    error => deletes === 2 && error.code === "MUTATION_OUTCOME_UNKNOWN" && error.outcomeUnknown === true,
  );
});

test("pause resume correction and note update return logical timer receipts", async () => {
  let entries = [
    segment({ id: 900, duration: 30, started_at: "2026-09-01T14:58:00Z", timer: { id: 901, is_running: false } }),
    segment({ id: 902 }),
  ];
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/time_entries" && options.method === "POST") {
      const created = segment({ id: 904, ...options.body.time_entry, timer: { id: 901, is_running: true } });
      entries.push(created);
      return { time_entry: created };
    }
    if (path.startsWith("/comments/business/123/time_entries/") && options.method === "PUT") {
      const id = Number(path.split("/").at(-1));
      entries = entries.map((entry) => entry.id === id ? { ...entry, ...options.body.time_entry } : entry);
      return { time_entry: entries.find((entry) => entry.id === id) };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const context = trackingContext();
  const service = new FreshBooksService({ client, configStore, now }).withTracking(context);
  let guard = await currentTimerGuard(service);

  const paused = await service.pauseTimer(901, { guard });
  guard = paused.results[0].token;
  const resumed = await service.resumeTimer(901, { guard });
  guard = resumed.results[0].token;
  const corrected = await service.correctTimer(901, 180, { guard });
  guard = corrected.results[0].token;
  const updated = await service.updateTimer(901, { note: "Updated note" }, { guard });

  for (const [result, mutationKind] of [
    [paused, "timer-pause"],
    [resumed, "timer-resume"],
    [corrected, "timer-correct"],
    [updated, "timer-update"],
  ]) {
    assert.equal(result.mutationKind, mutationKind);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].kind, "active-timer");
    assert.equal(result.results[0].id, "901");
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].scope, "active-timer:901");
    assert.equal(result.changes[0].after.record, result.results[0]);
  }
  assert.equal(updated.results[0].segments.length, 3);
  assert.equal(updated.results[0].note, "Updated note");
});

test("log and discard return deletion changes", async () => {
  let entries = [
    segment({ id: 900, duration: 30, timer: { id: 901, is_running: false } }),
    segment({ id: 902, duration: 60, started_at: "2026-09-01T14:59:00Z", timer: { id: 901, is_running: false } }),
  ];
  const client = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/project/44") return {
      project: { id: 44, active: true, complete: false, services: [{ id: 66, billable: true }] },
      abilities: [{ name: "can_track_time", value: true }],
    };
    if (path === "/comments/business/123/timers/901" && options.method === "PUT") {
      entries = [];
      return { time_entry: {
        id: 903, is_logged: true, duration: 90, started_at: "2026-09-01T14:58:00Z",
        project_id: 44, client_id: 55, service_id: 66, note: "Build shell plugin",
        billable: true, billed: false,
      } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());
  const logged = await service.logTimer(901, { guard: await currentTimerGuard(service) });

  assert.equal(logged.mutationKind, "timer-log");
  assert.deepEqual(logged.results.map((record) => [record.kind, record.exists]), [
    ["time-entry", true],
    ["active-timer", false],
  ]);
  assert.deepEqual(logged.changes.map((change) => [change.scope, change.after]), [
    ["time-entry:903", { record: logged.results[0] }],
    ["active-timer:901", { deleted: true }],
  ]);

  let discardEntries = [
    segment({ id: 910, duration: 30, timer: { id: 911, is_running: false } }),
    segment({ id: 912, timer: { id: 911, is_running: true } }),
  ];
  const discardClient = { async request(path, options = {}) {
    if (path === "/timetracking/business/123/time_entries") return { time_entries: discardEntries };
    if (path.startsWith("/timetracking/business/123/time_entries/") && options.method === "DELETE") {
      const id = Number(path.split("/").at(-1));
      discardEntries = discardEntries.filter((entry) => entry.id !== id);
      return {};
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const discardService = new FreshBooksService({ client: discardClient, configStore, now })
    .withTracking(trackingContext());
  const discarded = await discardService.discardTimer(911, {
    guard: await currentTimerGuard(discardService, 911),
  });

  assert.equal(discarded.mutationKind, "timer-discard");
  assert.equal(discarded.changes[0].scope, "active-timer:911");
  assert.deepEqual(discarded.changes[0].after, { deleted: true });
  assert.deepEqual(discarded.results, [{
    contractVersion: 2,
    kind: "active-timer",
    id: "911",
    exists: false,
    token: null,
  }]);
});

test("switch receipt stops and logs the old timer before starting the new one", async () => {
  let entries = [segment()];
  const requests = [];
  const client = { async request(path, options = {}) {
    requests.push({ path, ...options });
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/comments/business/123/project/44") return {
      project: { id: 44, active: true, complete: false, services: [{ id: 66, billable: true }] },
      abilities: [{ name: "can_track_time", value: true }],
    };
    if (path === "/comments/business/123/project/99") return {
      project: { id: 99, client_id: 77, active: true, complete: false, services: [{ id: 88, billable: false }] },
      abilities: [{ name: "can_track_time", value: true }],
    };
    if (path === "/comments/business/123/time_entries/900" && options.method === "PUT") {
      entries = [{ ...entries[0], ...options.body.time_entry, timer: { id: 901, is_running: false } }];
      return { time_entry: entries[0] };
    }
    if (path === "/comments/business/123/timers/901" && options.method === "PUT") {
      assert.notEqual(entries[0].duration, null);
      entries = [];
      return { time_entry: {
        id: 903, is_logged: true, duration: 60, started_at: "2026-09-01T14:59:00Z",
        project_id: 44, client_id: 55, service_id: 66, note: "Build shell plugin",
        billable: true, billed: false,
      } };
    }
    if (path === "/comments/business/123/time_entries" && options.method === "POST") {
      return { time_entry: { id: 904, timer: { id: 905 } } };
    }
    if (path === "/comments/business/123/time_entries/904" && options.method === "PUT") {
      entries = [{ id: 904, ...options.body.time_entry }];
      return { time_entry: entries[0] };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const service = new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());
  const result = await service.switchTimer(
    901,
    { project_id: 99, service_id: 88, note: "Next task" },
    { guard: await currentTimerGuard(service) },
  );

  assert.deepEqual(
    requests.filter((request) => request.method === "PUT").map((request) => request.path),
    [
      "/comments/business/123/time_entries/900",
      "/comments/business/123/timers/901",
      "/comments/business/123/time_entries/904",
    ],
  );
  assert.equal(result.mutationKind, "timer-switch");
  assert.deepEqual(result.phase, { log: "confirmed", start: "confirmed" });
  assert.deepEqual(result.results.map((record) => [record.kind, record.id, record.exists]), [
    ["time-entry", "903", true],
    ["active-timer", "901", false],
    ["active-timer", "905", true],
  ]);
  assert.deepEqual(result.changes.map((change) => change.scope), [
    "time-entry:903",
    "active-timer:901",
    "active-timer:905",
  ]);
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
  await assert.rejects(
    service.switchTimer(
      901,
      { project_id: 99, service_id: 77 },
      { guard: "stale" },
    ),
    { code: "PROJECT_NOT_ACTIVE" },
  );
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

test("timer status uses only the first include-unlogged page", async () => {
  const pages = [];
  const client = { async request(path, options = {}) {
    if (path !== "/timetracking/business/123/time_entries") {
      throw new Error(`Unexpected request: ${path}`);
    }
    pages.push(options.query.page);
    return {
      time_entries: options.query.page === 1 ? [segment()] : [],
      meta: { pages: 4 },
    };
  } };
  const context = new TrackingContext({
    timezone: "America/Chicago",
    observedAt: "2026-09-01T15:00:00Z",
  });
  const service = new FreshBooksService({ client, configStore, now }).withTracking(context);

  const observation = await service.timerStatusObservation();

  assert.deepEqual(pages, [1]);
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

test("timer start reports missing project before reading tracking configuration", async () => {
  let configReads = 0;
  const stderr = sink();

  assert.equal(await run(["timer", "start", "--force", "--json"], {
    service: new FreshBooksService({ client: {}, configStore }),
    configStore: {
      async read() {
        configReads += 1;
        throw new Error("configuration should not be read");
      },
    },
    secretStore: {},
    stdout: sink(),
    stderr,
  }), 2);

  assert.equal(configReads, 0);
  assert.deepEqual(JSON.parse(stderr.value).error, {
    code: "PROJECT_REQUIRED",
    message: "Starting a timer requires a project",
  });
});
