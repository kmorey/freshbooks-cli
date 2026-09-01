import test from "node:test";
import assert from "node:assert/strict";
import { FreshBooksService } from "../src/freshbooks.js";

function fixture() {
  const requests = [];
  const client = {
    async request(path, options = {}) {
      requests.push({ path, ...options });
      if (path === "/auth/api/v1/users/me") {
        return {
          response: {
            id: 88,
            business_memberships: [
              { role: "owner", business: { id: 123, name: "Acme", active: true } },
            ],
          },
        };
      }
      if (path === "/projects/business/123/project/44") return { project: { id: 44, client_id: 55 } };
      if (path === "/timetracking/business/123/time_entries" && !options.method) {
        return { time_entries: [] };
      }
      if (path === "/timetracking/business/123/time_entries" && options.method === "POST") {
        return {
          time_entry: {
            id: 900,
            ...options.body.time_entry,
            timer: { id: 901, is_running: true },
          },
        };
      }
      throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
    },
  };
  const configStore = {
    async read() {
      return { businessId: 123 };
    },
    async update() {},
  };
  const now = () => new Date("2026-09-01T15:00:00Z");
  return { service: new FreshBooksService({ client, configStore, now }), requests };
}

test("startTimer creates an official unlogged FreshBooks entry", async () => {
  const { service, requests } = fixture();
  const timer = await service.startTimer({ project_id: 44, note: "Build shell plugin" });
  const create = requests.find((request) => request.method === "POST");
  assert.deepEqual(create.body, {
    time_entry: {
      project_id: 44,
      note: "Build shell plugin",
      client_id: 55,
      identity_id: 88,
      is_logged: false,
      started_at: "2026-09-01T15:00:00.000Z",
      duration: 0,
    },
  });
  assert.equal(timer.id, 900);
  assert.equal(timer.timerId, 901);
  assert.equal(timer.running, true);
});

test("logTimer preserves the record and finalizes its timer", async () => {
  const requests = [];
  const existing = {
    id: 900,
    identity_id: 88,
    is_logged: false,
    started_at: "2026-09-01T14:00:00Z",
    project_id: 44,
    client_id: 55,
    note: "Work",
    duration: 0,
    timer: { id: 901, is_running: true },
  };
  const client = {
    async request(path, options = {}) {
      requests.push({ path, ...options });
      if (options.method === "PUT") {
        return { time_entry: { ...existing, ...options.body.time_entry, timer: { id: 901, is_running: false } } };
      }
      return { time_entry: existing };
    },
  };
  const configStore = { async read() { return { businessId: 123 }; } };
  const service = new FreshBooksService({
    client,
    configStore,
    now: () => new Date("2026-09-01T15:00:00Z"),
  });
  const logged = await service.logTimer(900);
  const update = requests.find((request) => request.method === "PUT");
  assert.equal(update.body.time_entry.started_at, existing.started_at);
  assert.equal(update.body.time_entry.is_logged, true);
  assert.equal(update.body.time_entry.duration, 3600);
  assert.deepEqual(update.body.time_entry.timer, { id: 901 });
  assert.equal(logged.elapsed_seconds, 3600);
});

test("activeTimers makes one bounded request instead of paginating all time-entry history", async () => {
  let timeEntryRequests = 0;
  const client = {
    async request(path) {
      if (path.includes("/time_entries")) {
        timeEntryRequests += 1;
        if (timeEntryRequests > 1) throw new Error("timer status walked into historical page 2");
        return { time_entries: [], meta: { page: 1, pages: 500 } };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  const configStore = { async read() { return { businessId: 123 }; } };
  const service = new FreshBooksService({ client, configStore });

  assert.deepEqual(await service.activeTimers(), []);
  assert.equal(timeEntryRequests, 1);
});
