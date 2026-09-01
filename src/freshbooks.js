import { CliError } from "./errors.js";
import { elapsedSeconds, formatDuration } from "./format.js";

export class FreshBooksService {
  constructor({ client, configStore, now = () => new Date() }) {
    this.client = client;
    this.configStore = configStore;
    this.now = now;
  }

  async identity() {
    const payload = await this.client.request("/auth/api/v1/users/me", {
      headers: { "Api-Version": "alpha" },
    });
    const identity = payload?.response || payload;
    if (!identity?.id) {
      throw new CliError("FreshBooks returned an unexpected identity response", {
        code: "INVALID_API_RESPONSE",
        details: payload,
      });
    }
    return identity;
  }

  async businesses() {
    const identity = await this.identity();
    return (identity.business_memberships || []).map((membership) => ({
      id: membership.business?.id,
      name: membership.business?.name,
      accountId: membership.business?.account_id,
      role: membership.role,
      active: membership.business?.active,
    }));
  }

  async selectBusiness(businessId) {
    const businesses = await this.businesses();
    const business = businesses.find((candidate) => candidate.id === businessId);
    if (!business) {
      throw new CliError(`Business ${businessId} is not available to the authenticated user`, {
        code: "BUSINESS_NOT_FOUND",
      });
    }
    await this.configStore.update({ businessId });
    return business;
  }

  async businessId() {
    const config = await this.configStore.read();
    if (config.businessId) return config.businessId;
    const businesses = (await this.businesses()).filter((business) => business.active !== false);
    if (businesses.length === 1) {
      await this.configStore.update({ businessId: businesses[0].id });
      return businesses[0].id;
    }
    throw new CliError(
      businesses.length === 0
        ? "No active FreshBooks business is available"
        : "Choose a business with `freshbooks business use <id>`",
      { code: "BUSINESS_REQUIRED" },
    );
  }

  async projects({ all = false } = {}) {
    const businessId = await this.businessId();
    const projects = [];
    let page = 1;
    let pages = 1;
    do {
      const payload = await this.client.request(`/projects/business/${businessId}/projects`, {
        query: { per_page: 100, page, ...(all ? {} : { active: true, complete: false }) },
      });
      projects.push(...(payload?.projects || payload?.response?.result?.projects || []));
      pages = Number(payload?.meta?.pages || payload?.response?.result?.meta?.pages || 1);
      page += 1;
    } while (page <= pages);
    return projects;
  }

  async project(projectId) {
    const businessId = await this.businessId();
    const payload = await this.client.request(`/projects/business/${businessId}/project/${projectId}`);
    return payload?.project || payload?.response?.result?.project || payload;
  }

  async listTimeEntries(filters = {}) {
    const businessId = await this.businessId();
    const entries = [];
    let page = 1;
    let pages = 1;
    do {
      const payload = await this.client.request(`/timetracking/business/${businessId}/time_entries`, {
        query: { per_page: 100, page, ...filters },
      });
      entries.push(...(payload?.time_entries || []));
      pages = Number(payload?.meta?.pages || 1);
      page += 1;
    } while (page <= pages);
    return entries;
  }

  async timeEntry(entryId) {
    const businessId = await this.businessId();
    const payload = await this.client.request(
      `/timetracking/business/${businessId}/time_entries/${entryId}`,
    );
    return payload?.time_entry || payload;
  }

  async createTimeEntry(fields) {
    const businessId = await this.businessId();
    const entry = { ...fields };
    if (!entry.identity_id) entry.identity_id = (await this.identity()).id;
    if (!entry.client_id && entry.project_id) {
      entry.client_id = (await this.project(entry.project_id)).client_id;
    }
    const payload = await this.client.request(`/timetracking/business/${businessId}/time_entries`, {
      method: "POST",
      body: { time_entry: compact(entry) },
    });
    return payload?.time_entry || payload;
  }

  async updateTimeEntry(entryId, patch) {
    const existing = await this.timeEntry(entryId);
    if (patch.project_id && patch.client_id === undefined && patch.project_id !== existing.project_id) {
      patch = { ...patch, client_id: (await this.project(patch.project_id)).client_id };
    }
    const entry = compact({ ...writableTimeEntry(existing), ...patch });
    const businessId = await this.businessId();
    const payload = await this.client.request(
      `/timetracking/business/${businessId}/time_entries/${entryId}`,
      { method: "PUT", body: { time_entry: entry } },
    );
    return payload?.time_entry || payload;
  }

  async deleteTimeEntry(entryId) {
    const businessId = await this.businessId();
    await this.client.request(`/timetracking/business/${businessId}/time_entries/${entryId}`, {
      method: "DELETE",
    });
    return { id: entryId, deleted: true };
  }

  async activeTimers() {
    const entries = await this.timerCandidates();
    return entries
      .filter((entry) => entry.is_logged === false || entry.timer?.is_running === true)
      .map((entry) => presentTimer(entry, this.now()));
  }

  async activeTimer(entryId) {
    if (entryId !== undefined) {
      const entry = await this.timeEntry(entryId);
      if (entry.is_logged !== false && entry.timer?.is_running !== true) {
        throw new CliError(`Time entry ${entryId} is not an active timer`, { code: "TIMER_NOT_ACTIVE" });
      }
      return entry;
    }
    const entries = await this.timerCandidates();
    const active = entries.filter(
      (entry) => entry.is_logged === false || entry.timer?.is_running === true,
    );
    if (active.length === 0) throw new CliError("No FreshBooks timer is active", { code: "NO_ACTIVE_TIMER" });
    if (active.length > 1) {
      throw new CliError("More than one FreshBooks timer is active; specify an entry ID", {
        code: "MULTIPLE_ACTIVE_TIMERS",
        details: active.map((entry) => entry.id),
      });
    }
    return active[0];
  }

  async timerCandidates() {
    const businessId = await this.businessId();
    // include_unlogged adds running/paused entries to the ordinary time-entry
    // result set. Timer polling must stay bounded instead of traversing the
    // account's complete history on every status check.
    const payload = await this.client.request(
      `/timetracking/business/${businessId}/time_entries`,
      { query: { include_unlogged: true, per_page: 100, page: 1 } },
    );
    return payload?.time_entries || [];
  }

  async startTimer(fields, { force = false } = {}) {
    if (!force) {
      const active = await this.activeTimers();
      if (active.length > 0) {
        throw new CliError(`Timer ${active[0].id} is already active`, {
          code: "TIMER_ALREADY_ACTIVE",
          details: active,
        });
      }
    }

    const startedAt = fields.started_at || this.now().toISOString();
    const entry = await this.createTimeEntry({
      ...fields,
      is_logged: false,
      started_at: startedAt,
      duration: 0,
    });
    return presentTimer(entry, this.now());
  }

  async logTimer(entryId) {
    const active = await this.activeTimer(entryId);
    const duration = elapsedSeconds(active, this.now());
    const entry = await this.updateTimeEntry(active.id, {
      is_logged: true,
      duration,
      ...(active.timer?.id ? { timer: { id: active.timer.id } } : {}),
    });
    return { ...entry, elapsed_seconds: duration, elapsed: formatDuration(duration) };
  }

  async discardTimer(entryId) {
    const active = await this.activeTimer(entryId);
    return this.deleteTimeEntry(active.id);
  }
}

export function writableTimeEntry(entry) {
  const fields = [
    "identity_id",
    "is_logged",
    "started_at",
    "client_id",
    "project_id",
    "pending_client",
    "pending_project",
    "pending_task",
    "task_id",
    "service_id",
    "note",
    "active",
    "billable",
    "billed",
    "internal",
    "retainer_id",
    "duration",
  ];
  return Object.fromEntries(fields.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]]));
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function presentTimer(entry, now = new Date()) {
  const elapsed = elapsedSeconds(entry, now);
  return {
    id: entry.id,
    timerId: entry.timer?.id,
    running: entry.timer?.is_running ?? entry.is_logged === false,
    isLogged: entry.is_logged,
    startedAt: entry.started_at,
    elapsedSeconds: elapsed,
    elapsed: formatDuration(elapsed),
    projectId: entry.project_id,
    clientId: entry.client_id,
    serviceId: entry.service_id,
    note: entry.note,
    billable: entry.billable,
  };
}
