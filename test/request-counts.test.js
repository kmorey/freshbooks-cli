import test from "node:test";
import assert from "node:assert/strict";
import { FreshBooksService } from "../src/freshbooks.js";
import {
  TrackingContext,
  canonicalActiveTimers,
  canonicalTimeEntry,
} from "../src/tracking.js";

const businessId = 123;
const observedAt = "2026-09-01T15:00:00Z";
const now = () => new Date(observedAt);
const configStore = {
  async read() { return { businessId, timezone: "America/Chicago" }; },
  async update() {},
};

function segment(overrides = {}) {
  return {
    id: 900,
    identity_id: 88,
    is_logged: false,
    duration: null,
    note: "Build shell plugin",
    internal: false,
    started_at: "2026-09-01T14:59:00Z",
    local_started_at: "2026-09-01T14:59:00Z",
    local_timezone: "America/Chicago",
    billable: true,
    billed: false,
    timer: { id: 901, is_running: true },
    client_id: 55,
    project_id: 44,
    service_id: 66,
    ...overrides,
  };
}

function trackingContext() {
  return new TrackingContext({ timezone: "America/Chicago", observedAt });
}

function serviceFor(client) {
  return new FreshBooksService({ client, configStore, now }).withTracking(trackingContext());
}

function timerGuard(entries, timerId = 901) {
  return canonicalActiveTimers(entries, { observedAt })
    .find((timer) => timer.id === String(timerId)).token;
}

function projectPayload(id = 44, serviceId = 66) {
  return {
    project: {
      id,
      client_id: 55,
      active: true,
      complete: false,
      services: [{ id: serviceId, billable: true }],
    },
    abilities: [{ name: "can_track_time", value: true }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("guarded time-entry update and delete use one detail read and one mutation", async () => {
  const raw = {
    id: 9,
    identity_id: 88,
    is_logged: true,
    duration: 60,
    started_at: "2026-09-01T14:00:00Z",
    local_timezone: "America/Chicago",
    project_id: 44,
    service_id: 66,
    note: "Before",
  };
  const guard = canonicalTimeEntry(raw, { timezone: "America/Chicago" }).token;

  for (const operation of ["update", "delete"]) {
    const requests = [];
    const client = { async request(path, options = {}) {
      requests.push({ path, method: options.method || "GET" });
      if (!options.method) return { time_entry: raw };
      if (options.method === "PUT") return { time_entry: { ...raw, note: "After" } };
      return {};
    } };
    const service = serviceFor(client);

    if (operation === "update") {
      await service.updateTimeEntry(9, { note: "After" }, { guard });
    } else {
      await service.deleteTimeEntry(9, { guard });
    }

    assert.deepEqual(requests.map(({ method }) => method), ["GET", operation === "update" ? "PUT" : "DELETE"]);
  }
});

test("one-segment pause resume and correction do not issue confirmation reads", async () => {
  const cases = [
    {
      name: "pause",
      entries: [segment()],
      invoke: (service, guard) => service.pauseTimer(901, { guard }),
      writeMethod: "PUT",
    },
    {
      name: "resume",
      entries: [segment({ duration: 60, timer: { id: 901, is_running: false } })],
      invoke: (service, guard) => service.resumeTimer(901, { guard }),
      writeMethod: "POST",
    },
    {
      name: "correct",
      entries: [segment()],
      invoke: (service, guard) => service.correctTimer(901, 120, { guard }),
      writeMethod: "PUT",
    },
  ];

  for (const scenario of cases) {
    let entries = scenario.entries;
    const requests = [];
    const client = { async request(path, options = {}) {
      const method = options.method || "GET";
      requests.push({ path, method });
      if (method === "GET") return { time_entries: entries };
      if (method === "POST") {
        const created = segment({ id: 902, ...options.body.time_entry });
        entries = [...entries, created];
        return { time_entry: created };
      }
      const id = Number(path.split("/").at(-1));
      entries = entries.map((entry) => entry.id === id ? { ...entry, ...options.body.time_entry } : entry);
      return { time_entry: entries.find((entry) => entry.id === id) };
    } };

    await scenario.invoke(serviceFor(client), timerGuard(entries));

    assert.equal(requests.filter(({ method }) => method === "GET").length, 1, scenario.name);
    assert.deepEqual(requests.filter(({ method }) => method !== "GET").map(({ method }) => method), [scenario.writeMethod], scenario.name);
  }
});

test("three-segment note and correction stay within one discovery and three writes", async () => {
  const initial = [
    segment({ id: 898, duration: 30, started_at: "2026-09-01T14:57:00Z" }),
    segment({ id: 899, duration: 30, started_at: "2026-09-01T14:58:00Z" }),
    segment({ id: 900 }),
  ];

  for (const operation of ["note", "correction"]) {
    let entries = structuredClone(initial);
    const requests = [];
    const client = { async request(path, options = {}) {
      const method = options.method || "GET";
      requests.push({ path, method });
      if (method === "GET") return { time_entries: entries };
      const id = Number(path.split("/").at(-1));
      entries = entries.map((entry) => entry.id === id ? { ...entry, ...options.body.time_entry } : entry);
      return { time_entry: entries.find((entry) => entry.id === id) };
    } };
    const service = serviceFor(client);
    const guard = timerGuard(entries);

    if (operation === "note") {
      await service.updateTimer(901, { note: "After" }, { guard });
    } else {
      await service.correctTimer(901, 180, { guard });
    }

    assert.equal(requests.filter(({ method }) => method === "GET").length, 1, operation);
    assert.ok(requests.filter(({ method }) => method === "PUT").length <= 3, operation);
  }
});

test("timer log uses discovery, project preflight, and one logical timer PUT", async () => {
  const entries = [segment({ duration: 60, timer: { id: 901, is_running: false } })];
  const requests = [];
  const client = { async request(path, options = {}) {
    const method = options.method || "GET";
    requests.push({ path, method });
    if (path === "/timetracking/business/123/time_entries") return { time_entries: entries };
    if (path === "/comments/business/123/project/44") return projectPayload();
    if (path === "/comments/business/123/timers/901" && method === "PUT") {
      return { time_entry: {
        id: 903, is_logged: true, duration: 60, started_at: entries[0].started_at,
        project_id: 44, client_id: 55, service_id: 66, note: entries[0].note,
        billable: true, billed: false,
      } };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  } };

  await serviceFor(client).logTimer(901, { guard: timerGuard(entries) });

  assert.deepEqual(requests, [
    { path: "/timetracking/business/123/time_entries", method: "GET" },
    { path: "/comments/business/123/project/44", method: "GET" },
    { path: "/comments/business/123/timers/901", method: "PUT" },
  ]);
});

test("timer switch reuses discovery, target project, and remembered identity", async () => {
  let entries = [segment({ duration: 60, timer: { id: 901, is_running: false } })];
  const requests = [];
  const discovery = deferred();
  const targetProject = deferred();
  let prerequisitesResolved = false;
  const client = { async request(path, options = {}) {
    const method = options.method || "GET";
    requests.push({ path, method });
    if (method !== "GET") assert.equal(prerequisitesResolved, true, `${method} began before prerequisites`);
    if (path === "/timetracking/business/123/time_entries") return discovery.promise;
    if (path === "/comments/business/123/project/99") return targetProject.promise;
    if (path === "/comments/business/123/project/44") return projectPayload();
    if (path === "/auth/api/v1/users/me") return { response: { id: 88 } };
    if (path === "/comments/business/123/timers/901" && method === "PUT") {
      entries = [];
      return { time_entry: {
        id: 903, is_logged: true, duration: 60, started_at: "2026-09-01T14:59:00Z",
        project_id: 44, client_id: 55, service_id: 66, note: "Build shell plugin",
        billable: true, billed: false,
      } };
    }
    if (path === "/comments/business/123/time_entries" && method === "POST") {
      return { time_entry: { id: 904, timer: { id: 905 } } };
    }
    if (path === "/comments/business/123/time_entries/904" && method === "PUT") {
      entries = [{ id: 904, ...options.body.time_entry }];
      return { time_entry: entries[0] };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  } };
  const pending = serviceFor(client).switchTimer(
    901,
    { project_id: 99, service_id: 88, note: "Next task" },
    { guard: timerGuard(entries) },
  );

  await nextTurn();
  const bothReadsStarted = requests.some(({ path }) => path.endsWith("/time_entries"))
    && requests.some(({ path }) => path.endsWith("/project/99"));
  assert.equal(requests.some(({ method }) => method !== "GET"), false);
  prerequisitesResolved = true;
  discovery.resolve({ time_entries: entries });
  targetProject.resolve(projectPayload(99, 88));
  await pending;

  assert.equal(bothReadsStarted, true);
  assert.deepEqual(requests, [
    { path: "/timetracking/business/123/time_entries", method: "GET" },
    { path: "/comments/business/123/project/99", method: "GET" },
    { path: "/comments/business/123/timers/901", method: "PUT" },
    { path: "/comments/business/123/time_entries", method: "POST" },
    { path: "/comments/business/123/time_entries/904", method: "PUT" },
  ]);
});

test("independent identity and project prerequisites overlap", async () => {
  const identity = deferred();
  const project = deferred();
  const started = [];
  const writes = [];
  const client = { async request(path, options = {}) {
    if (options.method) writes.push(path);
    if (path === "/timetracking/business/123/time_entries") return { time_entries: [] };
    if (path === "/auth/api/v1/users/me") {
      started.push("identity");
      return identity.promise;
    }
    if (path === "/comments/business/123/project/44") {
      started.push("project");
      return project.promise;
    }
    if (path === "/comments/business/123/time_entries" && options.method === "POST") {
      return { time_entry: { id: 900, timer: { id: 901 } } };
    }
    if (path === "/comments/business/123/time_entries/900" && options.method === "PUT") {
      return { time_entry: { id: 900, ...options.body.time_entry } };
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  } };
  const pending = serviceFor(client).startTimer({ project_id: 44, service_id: 66 });

  await nextTurn();
  const overlapped = started.includes("identity") && started.includes("project");
  assert.deepEqual(writes, []);
  identity.resolve({ response: { id: 88 } });
  project.resolve(projectPayload());
  await pending;

  assert.equal(overlapped, true);
});
