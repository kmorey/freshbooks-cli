import { CliError } from "./errors.js";
import { elapsedSeconds, formatDuration } from "./format.js";
import { createHash } from "node:crypto";

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

  async clients() {
    const selectedId = await this.businessId();
    const business = (await this.businesses()).find(
      (candidate) => Number(candidate.id) === Number(selectedId),
    );
    if (!business?.accountId) {
      throw new CliError("The selected business has no accounting account identity", {
        code: "INVALID_API_RESPONSE",
      });
    }
    const clients = [];
    let page = 1;
    let pages = 1;
    do {
      const payload = await this.client.request(
        `/accounting/account/${business.accountId}/users/clients`,
        { query: { "search[vis_state]": 0, per_page: 100, page } },
      );
      const result = payload?.response?.result || payload;
      clients.push(...(result?.clients || []));
      pages = Number(result?.meta?.pages || 1);
      page += 1;
    } while (page <= pages);
    return clients;
  }

  async clientRecords() {
    return (await this.clients()).map((client) => ({
      id: client.id,
      name: clientDisplayName(client),
      organization: String(client.organization || ""),
      active: client.vis_state !== 1,
    }));
  }

  async projectRecords(options = {}) {
    const [projects, clients] = await Promise.all([this.projects(options), this.clients()]);
    const names = new Map(clients.map((client) => [Number(client.id), clientDisplayName(client)]));
    return projects.map((project) => ({
      id: project.id,
      title: project.title || project.name || "",
      clientId: project.client_id ?? null,
      clientName: project.client_id == null ? "Internal" : names.get(Number(project.client_id)) || "",
      active: project.active !== false,
      complete: project.complete === true,
      internal: project.internal === true,
      services: (project.services || [])
        .filter((service) => service.vis_state !== 1)
        .map((service) => ({ id: service.id, name: service.name || "", billable: service.billable === true })),
    }));
  }

  async project(projectId) {
    const businessId = await this.businessId();
    const payload = await this.client.request(`/projects/business/${businessId}/project/${projectId}`);
    return payload?.project || payload?.response?.result?.project || payload;
  }

  async timerProject(projectId) {
    const businessId = await this.businessId();
    const payload = await this.client.request(
      `/comments/business/${businessId}/project/${projectId}`,
    );
    return {
      project: payload?.project || payload?.response?.result?.project || payload,
      abilities: payload?.abilities || payload?.response?.result?.abilities || [],
    };
  }

  async listTimeEntries(filters = {}, { limit } = {}) {
    const businessId = await this.businessId();
    const entries = [];
    let page = 1;
    let pages = 1;
    do {
      const payload = await this.client.request(`/timetracking/business/${businessId}/time_entries`, {
        query: { per_page: 100, page, ...filters },
      });
      entries.push(...(payload?.time_entries || []));
      if (limit && entries.length >= limit) break;
      pages = Number(payload?.meta?.pages || 1);
      page += 1;
    } while (page <= pages);
    return limit ? entries.slice(0, limit) : entries;
  }

  async timeEntry(entryId) {
    const businessId = await this.businessId();
    const payload = await this.client.request(
      `/timetracking/business/${businessId}/time_entries/${entryId}`,
    );
    return payload?.time_entry || payload;
  }

  async timeEntryRecords(filters = {}, options = {}) {
    const timezone = (await this.configStore.read()).timezone;
    return (await this.listTimeEntries(filters, options))
      .filter((entry) => entry.is_logged === true)
      .map((entry) => presentTimeEntry(entry, { timezone }));
  }

  async createTimeEntry(fields) {
    const businessId = await this.businessId();
    let entry = { ...fields };
    if (!entry.identity_id) entry.identity_id = (await this.identity()).id;
    if (entry.project_id) {
      const { project, abilities } = await this.timerProject(entry.project_id);
      const service = selectProjectService(project, entry.service_id);
      assertTrackableProject(project, service, abilities);
      entry = {
        ...entry,
        client_id: project.client_id ?? null,
        service_id: service.id,
        billable: project.internal === true ? false : service.billable === true,
        internal: project.internal === true,
      };
    }
    const payload = await this.client.request(`/timetracking/business/${businessId}/time_entries`, {
      method: "POST",
      body: { time_entry: compact(entry) },
    });
    const timezone = (await this.configStore.read()).timezone;
    return presentTimeEntry(payload?.time_entry || payload, { timezone });
  }

  async updateTimeEntry(entryId, patch, { snapshotToken } = {}) {
    const existing = await this.timeEntry(entryId);
    assertSnapshot(snapshotToken, entrySnapshot(existing), presentTimeEntry(existing));
    if (patch.project_id !== undefined || patch.service_id !== undefined) {
      const projectId = patch.project_id ?? existing.project_id;
      const serviceId = patch.service_id ?? existing.service_id;
      const { project, abilities } = await this.timerProject(projectId);
      const service = selectProjectService(project, serviceId);
      assertTrackableProject(project, service, abilities);
      patch = {
        ...patch,
        project_id: projectId,
        client_id: project.client_id ?? null,
        service_id: service.id,
        billable: project.internal === true ? false : service.billable === true,
        internal: project.internal === true,
      };
    }
    const entry = compact({ ...writableTimeEntry(existing), ...patch });
    const businessId = await this.businessId();
    const payload = await this.client.request(
      `/timetracking/business/${businessId}/time_entries/${entryId}`,
      { method: "PUT", body: { time_entry: entry } },
    );
    const timezone = (await this.configStore.read()).timezone;
    return presentTimeEntry(payload?.time_entry || payload, { timezone });
  }

  async deleteTimeEntry(entryId, { snapshotToken } = {}) {
    const existing = await this.timeEntry(entryId);
    assertSnapshot(snapshotToken, entrySnapshot(existing), presentTimeEntry(existing));
    const businessId = await this.businessId();
    await this.client.request(`/timetracking/business/${businessId}/time_entries/${entryId}`, {
      method: "DELETE",
    });
    return { id: entryId, deleted: true };
  }

  async localDateFields(dateKey) {
    if (!validDateKey(dateKey)) {
      throw new CliError("Time entry date must use YYYY-MM-DD", {
        code: "INVALID_ARGUMENT",
        exitCode: 2,
      });
    }
    const timezone = (await this.configStore.read()).timezone;
    const localStartedAt = `${dateKey}T12:00:00`;
    try {
      return {
        started_at: zonedLocalToUtc(localStartedAt, timezone).toISOString(),
        local_started_at: localStartedAt,
        local_timezone: timezone,
      };
    } catch {
      throw new CliError(`Invalid FreshBooks timezone: ${timezone}`, {
        code: "INVALID_TIMEZONE",
        exitCode: 2,
      });
    }
  }

  async localRangeBoundary(value, { endOfDay = false } = {}) {
    if (!validDateKey(value)) {
      throw new CliError("Time entry range date must use a valid YYYY-MM-DD date", {
        code: "INVALID_ARGUMENT",
        exitCode: 2,
      });
    }
    const timezone = (await this.configStore.read()).timezone;
    const boundaryDate = endOfDay ? addDateKey(value, 1) : value;
    try {
      const boundary = zonedLocalToUtc(`${boundaryDate}T00:00:00`, timezone);
      return endOfDay ? new Date(boundary.getTime() - 1) : boundary;
    } catch {
      throw new CliError(`Invalid FreshBooks timezone: ${timezone}`, {
        code: "INVALID_TIMEZONE",
        exitCode: 2,
      });
    }
  }

  async activeTimers() {
    const entries = await this.timerCandidates();
    return groupTimerSegments(entries, this.now());
  }

  async activeTimer(timerId) {
    const active = await this.activeTimers();
    if (timerId !== undefined) {
      const timer = active.find(
        (candidate) => candidate.id === timerId || candidate.segmentIds.includes(timerId),
      );
      if (!timer) {
        throw new CliError(`Timer ${timerId} is not active`, { code: "TIMER_NOT_ACTIVE" });
      }
      return timer;
    }
    if (active.length === 0) throw new CliError("No FreshBooks timer is active", { code: "NO_ACTIVE_TIMER" });
    if (active.length > 1) {
      throw new CliError("More than one FreshBooks timer is active; specify a timer ID", {
        code: "MULTIPLE_ACTIVE_TIMERS",
        details: active.map((timer) => timer.id),
      });
    }
    return active[0];
  }

  async timerCandidates() {
    const businessId = await this.businessId();
    const identityId = (await this.identity()).id;
    // include_unlogged adds running/paused entries to the ordinary time-entry
    // result set. Timer polling must stay bounded instead of traversing the
    // account's complete history on every status check.
    const payload = await this.client.request(
      `/timetracking/business/${businessId}/time_entries`,
      { query: { include_unlogged: true, identity_id: identityId, per_page: 100, page: 1 } },
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

    if (!fields.project_id) {
      throw new CliError("Starting a timer requires a project", {
        code: "PROJECT_REQUIRED",
        exitCode: 2,
      });
    }
    const businessId = await this.businessId();
    const identity = await this.identity();
    const timezone = (await this.configStore.read()).timezone;
    const { project, abilities } = await this.timerProject(fields.project_id);
    const service = selectProjectService(project, fields.service_id);
    assertTrackableProject(project, service, abilities);
    const startedAt = fields.started_at || this.now().toISOString();
    const common = timerEntryFields({
      ...fields,
      client_id: project.client_id ?? null,
      service_id: service?.id ?? fields.service_id ?? null,
      billable: project.internal === true ? false : (service?.billable ?? fields.billable ?? false),
      internal: project.internal === true,
      is_logged: false,
      started_at: startedAt,
      local_started_at: fields.local_started_at ?? null,
      local_timezone: fields.local_timezone ?? timezone,
      duration: null,
    });
    const createdPayload = await this.client.request(
      `/comments/business/${businessId}/time_entries`,
      { method: "POST", body: { time_entry: { ...common, note: null, internal: false, timer: {}, identity_id: null, client_id: null, project_id: null, service_id: null } } },
    );
    const created = createdPayload?.time_entry || createdPayload;
    if (!created?.id || !created?.timer?.id) {
      throw new CliError("FreshBooks did not create a timer identity", {
        code: "INVALID_API_RESPONSE",
        details: createdPayload,
      });
    }
    const assigned = {
      ...common,
      identity_id: identity.id,
      timer: { id: created.timer.id },
    };
    await this.client.request(
      `/comments/business/${businessId}/time_entries/${created.id}`,
      { method: "PUT", body: { time_entry: assigned } },
    );
    return this.requireRefreshedTimer(created.timer.id);
  }

  async pauseTimer(timerId, { snapshotToken } = {}) {
    const timer = await this.activeTimer(timerId);
    assertSnapshot(snapshotToken, timer.snapshotToken, publicTimer(timer));
    if (!timer.running || !timer._openSegment) return timer;
    const duration = Math.max(
      0,
      Math.floor((this.now().getTime() - new Date(timer._openSegment.started_at).getTime()) / 1000),
    );
    await this.updateTimerSegment(timer._openSegment, { duration });
    return this.requireRefreshedTimer(timer.id);
  }

  async resumeTimer(timerId, { snapshotToken } = {}) {
    const timer = await this.activeTimer(timerId);
    assertSnapshot(snapshotToken, timer.snapshotToken, publicTimer(timer));
    if (timer.running) return timer;
    const template = timer._segments.at(-1);
    const businessId = await this.businessId();
    await this.client.request(`/comments/business/${businessId}/time_entries`, {
      method: "POST",
      body: {
        time_entry: timerEntryFields({
          ...template,
          id: undefined,
          duration: null,
          started_at: this.now().toISOString(),
          local_started_at: null,
          identity_id: null,
          timer: { id: timer.id },
        }),
      },
    });
    return this.requireRefreshedTimer(timer.id);
  }

  async correctTimer(timerId, targetSeconds, { snapshotToken } = {}) {
    const timer = await this.activeTimer(timerId);
    assertSnapshot(snapshotToken, timer.snapshotToken, publicTimer(timer));
    if (!Number.isSafeInteger(targetSeconds) || targetSeconds < 0) {
      throw new CliError("Timer duration must be whole non-negative seconds", {
        code: "INVALID_DURATION",
        exitCode: 2,
      });
    }
    const closed = timer._segments.filter((segment) => segment.duration != null);
    const closedSeconds = closed.reduce((total, segment) => total + Number(segment.duration || 0), 0);
    if (timer.running) {
      if (targetSeconds < closedSeconds) {
        throw new CliError("Duration cannot be shorter than completed timer segments", {
          code: "DURATION_BELOW_CLOSED_SEGMENTS",
          details: { minimumSeconds: closedSeconds },
        });
      }
      const startedAt = new Date(this.now().getTime() - (targetSeconds - closedSeconds) * 1000).toISOString();
      for (const segment of timer._segments) {
        await this.updateTimerSegment(segment, segment.id === timer._openSegment.id
          ? { started_at: startedAt, local_started_at: startedAt }
          : {});
      }
    } else {
      const last = closed.at(-1);
      const priorSeconds = closed.slice(0, -1).reduce((total, segment) => total + Number(segment.duration || 0), 0);
      if (!last || targetSeconds < priorSeconds) {
        throw new CliError("Duration cannot be shorter than earlier timer segments", {
          code: "DURATION_BELOW_CLOSED_SEGMENTS",
          details: { minimumSeconds: priorSeconds },
        });
      }
      await this.updateTimerSegment(last, { duration: targetSeconds - priorSeconds });
    }
    return this.requireRefreshedTimer(timer.id);
  }

  async updateTimer(timerId, patch, { snapshotToken } = {}) {
    const timer = await this.activeTimer(timerId);
    assertSnapshot(snapshotToken, timer.snapshotToken, publicTimer(timer));
    for (const segment of timer._segments) await this.updateTimerSegment(segment, patch);
    return this.requireRefreshedTimer(timer.id);
  }

  async logTimer(timerId, { snapshotToken } = {}) {
    let timer = await this.activeTimer(timerId);
    assertSnapshot(snapshotToken, timer.snapshotToken, publicTimer(timer));
    if (timer.running) timer = await this.pauseTimer(timer.id, { snapshotToken: timer.snapshotToken });
    const { project, abilities } = await this.timerProject(timer.projectId);
    const selectedService = selectProjectService(project, timer.serviceId);
    assertTrackableProject(project, selectedService, abilities);
    const businessId = await this.businessId();
    const payload = await this.client.request(`/comments/business/${businessId}/timers/${timer.id}`, {
      method: "PUT",
      body: { timer: { time_entries: timer._segments.map((segment) => timerEntryFields(segment)) } },
    });
    const entry = payload?.time_entry || payload?.timer?.time_entry || payload?.timer || payload;
    const timezone = (await this.configStore.read()).timezone;
    return {
      ...presentTimeEntry(entry, { timezone }),
      timerId: timer.id,
      elapsedSeconds: timer.elapsedSeconds,
      elapsed: formatDuration(timer.elapsedSeconds),
    };
  }

  async switchTimer(timerId, fields, { snapshotToken } = {}) {
    if (!fields.project_id) {
      throw new CliError("Switching a timer requires a target project", {
        code: "PROJECT_REQUIRED",
        exitCode: 2,
      });
    }
    const { project, abilities } = await this.timerProject(fields.project_id);
    const service = selectProjectService(project, fields.service_id);
    assertTrackableProject(project, service, abilities);
    let logged = null;
    const timers = await this.activeTimers();
    if (timers.length > 0) logged = await this.logTimer(timerId, { snapshotToken });
    try {
      const timer = await this.startTimer(fields);
      return { logged, timer, partial: false };
    } catch (error) {
      if (logged) {
        throw new CliError("The previous timer logged, but the next timer did not start", {
          code: "TIMER_SWITCH_PARTIAL",
          details: { logged, startError: { code: error.code, message: error.message } },
        });
      }
      throw error;
    }
  }

  async discardTimer(timerId) {
    const timer = await this.activeTimer(timerId);
    for (const segment of timer._segments) await this.deleteTimeEntry(segment.id);
    return { id: timer.id, segmentIds: timer.segmentIds, deleted: true };
  }

  async updateTimerSegment(segment, patch) {
    const businessId = await this.businessId();
    const entry = timerEntryFields({ ...segment, ...patch, timer: { id: segment.timer?.id } });
    const payload = await this.client.request(
      `/comments/business/${businessId}/time_entries/${segment.id}`,
      { method: "PUT", body: { time_entry: entry } },
    );
    return payload?.time_entry || payload;
  }

  async requireRefreshedTimer(timerId) {
    const timer = (await this.activeTimers()).find((candidate) => candidate.id === timerId);
    if (!timer) {
      throw new CliError("FreshBooks did not return the expected active timer", {
        code: "TIMER_RECONCILIATION_FAILED",
      });
    }
    return timer;
  }
}

export function writableTimeEntry(entry) {
  const fields = [
    "identity_id",
    "is_logged",
    "started_at",
    "local_started_at",
    "local_timezone",
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

export function timerEntryFields(entry) {
  const fields = [
    "is_logged", "duration", "note", "internal", "retainer_id", "pending_client",
    "pending_project", "pending_task", "source", "started_at", "local_started_at",
    "local_timezone", "billable", "billed", "timer", "identity_id", "client_id",
    "project_id", "service_id",
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

export function groupTimerSegments(entries, now = new Date()) {
  const grouped = new Map();
  for (const entry of entries || []) {
    if (entry?.is_logged !== false || entry?.timer?.id == null) continue;
    const key = Number(entry.timer.id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  return [...grouped.entries()].map(([timerId, segments]) => {
    segments.sort((left, right) => new Date(left.started_at) - new Date(right.started_at));
    const openSegments = segments.filter((segment) => segment.duration == null);
    const current = openSegments.at(-1) || segments.at(-1);
    const elapsed = segments.reduce(
      (total, segment) => total + (segment.duration == null ? elapsedSeconds(segment, now) : Math.max(0, Number(segment.duration) || 0)),
      0,
    );
    const timer = {
      id: timerId,
      timerId,
      segmentIds: segments.map((segment) => segment.id),
      segments: segments.map(presentTimerSegment),
      openSegment: openSegments.length ? presentTimerSegment(openSegments.at(-1)) : null,
      running: openSegments.length > 0,
      isLogged: false,
      startedAt: segments[0]?.started_at,
      elapsedSeconds: elapsed,
      elapsed: formatDuration(elapsed),
      projectId: current?.project_id,
      clientId: current?.client_id,
      serviceId: current?.service_id,
      note: current?.note,
      billable: current?.billable,
      snapshotToken: logicalTimerSnapshot(segments),
    };
    Object.defineProperties(timer, {
      _segments: { value: segments },
      _openSegment: { value: openSegments.at(-1) || null },
    });
    return timer;
  });
}

function presentTimerSegment(segment) {
  return {
    id: segment.id,
    startedAt: segment.started_at,
    localStartedAt: segment.local_started_at ?? null,
    durationSeconds: segment.duration == null ? null : Math.max(0, Number(segment.duration) || 0),
    running: segment.duration == null,
  };
}

function selectProjectService(project, serviceId) {
  const services = project?.services || [];
  if (serviceId != null) return services.find((service) => Number(service.id) === Number(serviceId));
  return services.length === 1 ? services[0] : undefined;
}

function assertTrackableProject(project, service, abilities = []) {
  if (!project || project.active === false || project.complete === true) {
    throw new CliError("The selected project is not active", { code: "PROJECT_NOT_ACTIVE" });
  }
  if (!service) {
    throw new CliError("The selected service is not available on the project", {
      code: "SERVICE_NOT_AVAILABLE",
    });
  }
  const canTrackTime = abilities.find((ability) => ability?.name === "can_track_time");
  if (canTrackTime?.value === false) {
    throw new CliError("The authenticated user cannot track time on this project", {
      code: "TIME_TRACKING_NOT_ALLOWED",
    });
  }
}

function clientDisplayName(client) {
  const organization = String(client?.organization || "").trim();
  if (organization) return organization;
  return [client?.fname, client?.lname].filter(Boolean).join(" ").trim();
}

function zonedLocalToUtc(localTimestamp, timezone) {
  const [datePart, timePart] = localTimestamp.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const observed = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const adjustment = desired - observed;
    candidate += adjustment;
    if (adjustment === 0) return new Date(candidate);
  }
  return new Date(candidate);
}

function addDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function validDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function presentTimeEntry(entry, { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const startedAt = entry.started_at || null;
  const localStartedAt = entry.local_started_at || null;
  return {
    id: entry.id,
    startedAt,
    localStartedAt,
    localDate: localStartedAt ? String(localStartedAt).slice(0, 10) : dateInTimezone(startedAt, timezone),
    durationSeconds: Math.max(0, Number(entry.duration) || 0),
    projectId: entry.project_id ?? null,
    clientId: entry.client_id ?? null,
    serviceId: entry.service_id ?? null,
    note: entry.note || "",
    billable: entry.billable === true,
    billed: entry.billed === true,
    snapshotToken: entrySnapshot(entry),
  };
}

function dateInTimezone(timestamp, timezone) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function logicalTimerSnapshot(segments) {
  return digest(segments.map(snapshotEntryFields));
}

function entrySnapshot(entry) {
  return digest(snapshotEntryFields(entry));
}

function snapshotEntryFields(entry) {
  return {
    id: entry?.id,
    is_logged: entry?.is_logged,
    duration: entry?.duration,
    started_at: entry?.started_at,
    local_started_at: entry?.local_started_at,
    note: entry?.note,
    project_id: entry?.project_id,
    client_id: entry?.client_id,
    service_id: entry?.service_id,
    billable: entry?.billable,
    timer_id: entry?.timer?.id,
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertSnapshot(expected, actual, authoritative) {
  if (!expected || expected === actual) return;
  throw new CliError("The FreshBooks record changed since it was loaded", {
    code: "REMOTE_CHANGED",
    details: { authoritative },
  });
}

function publicTimer(timer) {
  return Object.fromEntries(Object.entries(timer).filter(([key]) => !key.startsWith("_")));
}
