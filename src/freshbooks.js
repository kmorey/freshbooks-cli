import { CliError } from "./errors.js";
import { elapsedSeconds, formatDuration } from "./format.js";
import {
  assertGuard,
  canonicalActiveTimers,
  canonicalDeleted,
  canonicalTimeEntry,
  receipt,
  recordScope,
} from "./tracking.js";

function ambiguousMutation(error, mutationKind) {
  if (error?.outcomeUnknown === true) return error;
  return new CliError("FreshBooks accepted part of the mutation, but its final outcome is unknown", {
    code: "MUTATION_OUTCOME_UNKNOWN",
    outcomeUnknown: true,
    details: {
      mutationKind,
      cause: {
        code: error?.code || "UNEXPECTED_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    },
  });
}

export class FreshBooksService {
  constructor({ client, configStore, now = () => new Date(), trackingContext = null }) {
    this.client = client;
    this.configStore = configStore;
    this.now = now;
    this.trackingContext = trackingContext;
  }

  withTracking(context) {
    const bound = Object.create(Object.getPrototypeOf(this));
    return Object.assign(bound, this, { trackingContext: context });
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
    const entries = (await this.listTimeEntries(filters, options))
      .filter((entry) => entry.is_logged === true);
    if (!this.trackingContext) {
      const timezone = (await this.configStore.read()).timezone;
      return entries.map((entry) => presentTimeEntry(entry, { timezone }));
    }
    return entries.map((entry) => this.trackingContext.remember(
      canonicalTimeEntry(entry, { timezone: this.trackingContext.timezone }),
    ));
  }

  async timeEntryObservation(filters = {}, { coverage, ...options } = {}) {
    const records = await this.timeEntryRecords(filters, options);
    return this.requireTracking().observe({
      queryKey: "time-list",
      coverage: {
        complete: coverage?.complete === true,
        includesDeleted: false,
        fromDate: coverage?.fromDate ?? null,
        toDate: coverage?.toDate ?? null,
      },
      records,
    });
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
    const context = this.trackingContext;
    const timezone = context?.timezone ?? (await this.configStore.read()).timezone;
    const created = canonicalTimeEntry(payload, { timezone });
    context?.remember(created);
    return receipt("time-entry-create", [{
      scope: recordScope(created),
      before: { absent: true },
      after: { record: created },
    }], [created]);
  }

  async updateTimeEntry(entryId, patch, { guard } = {}) {
    const { existing, current: before } = await this.guardedTimeEntry(entryId, guard);
    const entry = Object.assign(writableTimeEntry(existing), compact(patch));
    if (patch.project_id !== undefined || patch.service_id !== undefined) {
      delete entry.client_id;
      delete entry.billable;
      delete entry.internal;
    }
    const businessId = await this.businessId();
    const payload = await this.client.request(
      `/timetracking/business/${businessId}/time_entries/${entryId}`,
      { method: "PUT", body: { time_entry: entry } },
    );
    const context = this.requireTracking();
    const updated = context.remember(canonicalTimeEntry(payload, {
      timezone: context.timezone,
    }));
    return receipt("time-entry-update", [{
      scope: recordScope(updated),
      before: { token: before.token },
      after: { record: updated },
    }], [updated]);
  }

  async deleteTimeEntry(entryId, { guard } = {}) {
    const { current: before } = await this.guardedTimeEntry(entryId, guard);
    await this.deleteTimeEntryRecord(entryId);
    const deleted = this.requireTracking().remember(canonicalDeleted("time-entry", entryId));
    return receipt("time-entry-delete", [{
      scope: recordScope(deleted),
      before: { token: before.token },
      after: { deleted: true },
    }], [deleted]);
  }

  async deleteTimeEntryRecord(entryId) {
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
    if (this.trackingContext) {
      for (const record of canonicalActiveTimers(entries, {
        observedAt: this.trackingContext.observedAt,
      })) {
        this.trackingContext.remember(record);
      }
    }
    return groupTimerSegments(entries, this.now());
  }

  async timerStatusObservation() {
    const context = this.requireTracking();
    const entries = await this.timerCandidates({ complete: true });
    const records = canonicalActiveTimers(entries, {
      observedAt: context.observedAt,
    });
    return context.observe({
      queryKey: "timer-status",
      coverage: {
        complete: true,
        includesDeleted: false,
        fromDate: null,
        toDate: null,
      },
      records,
    });
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

  async timerCandidates({ complete = false } = {}) {
    const businessId = await this.businessId();
    // include_unlogged adds running/paused entries to the ordinary time-entry
    // result set and FreshBooks scopes the list to the authenticated user by
    // default. Mutation discovery stays bounded to page 1, while canonical
    // status reads traverse all reported pages before claiming completeness.
    // Do not add an identity_id filter: FreshBooks rejects that combination
    // with HTTP 422.
    const entries = [];
    let page = 1;
    let pages = 1;
    do {
      const payload = await this.client.request(
        `/timetracking/business/${businessId}/time_entries`,
        { query: { include_unlogged: true, per_page: 100, page } },
      );
      entries.push(...(payload?.time_entries || []));
      pages = complete ? Number(payload?.meta?.pages || 1) : 1;
      page += 1;
    } while (page <= pages);
    return entries;
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
    const [identity, target, config] = await Promise.all([
      this.identity(),
      this.timerProject(fields.project_id),
      this.configStore.read(),
    ]);
    return this.startTimerState(fields, {
      identity,
      ...target,
      timezone: config.timezone,
    });
  }

  async startTimerState(fields, { identity, project, abilities, timezone }) {
    const service = selectProjectService(project, fields.service_id);
    assertTrackableProject(project, service, abilities);
    const businessId = await this.businessId();
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
    try {
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
      const assignedPayload = await this.client.request(
        `/comments/business/${businessId}/time_entries/${created.id}`,
        { method: "PUT", body: { time_entry: assigned } },
      );
      const confirmed = {
        ...created,
        ...assigned,
        ...(assignedPayload?.time_entry || assignedPayload),
        id: created.id,
        timer: { id: created.timer.id },
      };
      const timer = this.rememberTimerSegments([confirmed], created.timer.id);
      const result = this.currentTimerRecord(timer);
      return receipt("timer-start", [{
        scope: recordScope(result),
        before: { absent: true },
        after: { record: result },
      }], [result]);
    } catch (error) {
      throw ambiguousMutation(error, "timer-start");
    }
  }

  async pauseTimer(timerId, { guard } = {}) {
    const timer = await this.guardedActiveTimer(timerId, guard);
    const before = this.currentTimerRecord(timer);
    const updated = await this.pauseTimerState(timer);
    return this.activeTimerReceipt("timer-pause", before, updated);
  }

  async pauseTimerState(timer) {
    if (!timer.running || !timer._openSegment) return timer;
    const duration = Math.max(
      0,
      Math.floor((this.now().getTime() - new Date(timer._openSegment.started_at).getTime()) / 1000),
    );
    const updated = await this.updateTimerSegment(timer._openSegment, { duration });
    return this.timerWithReplacements(timer, [updated]);
  }

  async resumeTimer(timerId, { guard } = {}) {
    const timer = await this.guardedActiveTimer(timerId, guard);
    const before = this.currentTimerRecord(timer);
    if (timer.running) return this.activeTimerReceipt("timer-resume", before, timer);
    const template = timer._segments.at(-1);
    const businessId = await this.businessId();
    const payload = await this.client.request(`/comments/business/${businessId}/time_entries`, {
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
    const created = payload?.time_entry || payload;
    const updated = this.rememberTimerSegments([...this.timerSegments(timer), created], timer.id);
    return this.activeTimerReceipt("timer-resume", before, updated);
  }

  async correctTimer(timerId, targetSeconds, { guard } = {}) {
    const timer = await this.guardedActiveTimer(timerId, guard);
    const before = this.currentTimerRecord(timer);
    if (!Number.isSafeInteger(targetSeconds) || targetSeconds < 0) {
      throw new CliError("Timer duration must be whole non-negative seconds", {
        code: "INVALID_DURATION",
        exitCode: 2,
      });
    }
    const closed = timer._segments.filter((segment) => segment.duration != null);
    const continuedSeconds = Math.max(0, Number(timer.continuedSeconds) || 0);
    const closedSeconds = continuedSeconds
      + closed.reduce((total, segment) => total + Number(segment.duration || 0), 0);
    const replacements = [];
    let confirmedWrites = 0;
    try {
      if (timer.running) {
        if (targetSeconds < closedSeconds) {
          throw new CliError("Duration cannot be shorter than completed timer segments", {
            code: "DURATION_BELOW_CLOSED_SEGMENTS",
            details: { minimumSeconds: closedSeconds },
          });
        }
        const startedAt = new Date(this.now().getTime() - (targetSeconds - closedSeconds) * 1000).toISOString();
        for (const segment of timer._segments) {
          replacements.push(await this.updateTimerSegment(
            segment,
            segment.id === timer._openSegment.id
              ? { started_at: startedAt, local_started_at: startedAt }
              : {},
          ));
          confirmedWrites += 1;
        }
      } else {
        const last = closed.at(-1);
        const priorSeconds = continuedSeconds
          + closed.slice(0, -1).reduce((total, segment) => total + Number(segment.duration || 0), 0);
        if (!last || targetSeconds < priorSeconds) {
          throw new CliError("Duration cannot be shorter than earlier timer segments", {
            code: "DURATION_BELOW_CLOSED_SEGMENTS",
            details: { minimumSeconds: priorSeconds },
          });
        }
        replacements.push(await this.updateTimerSegment(last, { duration: targetSeconds - priorSeconds }));
        confirmedWrites += 1;
      }
      const updated = this.timerWithReplacements(timer, replacements);
      return this.activeTimerReceipt("timer-correct", before, updated);
    } catch (error) {
      if (confirmedWrites > 0) throw ambiguousMutation(error, "timer-correct");
      throw error;
    }
  }

  async updateTimer(timerId, patch, { guard } = {}) {
    const timer = await this.guardedActiveTimer(timerId, guard);
    const before = this.currentTimerRecord(timer);
    const replacements = [];
    let confirmedWrites = 0;
    try {
      for (const segment of timer._segments) {
        replacements.push(await this.updateTimerSegment(segment, patch));
        confirmedWrites += 1;
      }
      const updated = this.timerWithReplacements(timer, replacements);
      return this.activeTimerReceipt("timer-update", before, updated);
    } catch (error) {
      if (confirmedWrites > 0) throw ambiguousMutation(error, "timer-update");
      throw error;
    }
  }

  async logTimer(timerId, { guard } = {}) {
    const timer = await this.guardedActiveTimer(timerId, guard);
    const before = this.currentTimerRecord(timer);
    const { project, abilities } = await this.timerProject(timer.projectId);
    const selectedService = selectProjectService(project, timer.serviceId);
    assertTrackableProject(project, selectedService, abilities);
    return this.logTimerState(timer, before);
  }

  async logTimerState(timer, before) {
    const businessId = await this.businessId();
    const payload = await this.client.request(`/comments/business/${businessId}/timers/${timer.id}`, {
      method: "PUT",
      body: { timer: { time_entries: timer._segments.map((segment) => timerEntryFields(segment)) } },
    });
    const entry = payload?.time_entry || payload?.timer?.time_entry || payload?.timer || payload;
    const context = this.requireTracking();
    const logged = context.remember(canonicalTimeEntry(entry, {
      timezone: context.timezone,
    }));
    const deleted = context.remember(canonicalDeleted("active-timer", timer.id));
    return receipt("timer-log", [{
      scope: recordScope(logged),
      before: { absent: true },
      after: { record: logged },
    }, {
      scope: recordScope(deleted),
      before: { token: before.token },
      after: { deleted: true },
    }], [logged, deleted]);
  }

  async switchTimer(timerId, fields, { guard } = {}) {
    if (!fields.project_id) {
      throw new CliError("Switching a timer requires a target project", {
        code: "PROJECT_REQUIRED",
        exitCode: 2,
      });
    }
    requireTimerMutationGuard(timerId, guard);
    const [timerResult, target, config] = await Promise.all([
      this.activeTimer(timerId).then(
        (timer) => ({ timer }),
        (error) => ({ error }),
      ),
      this.timerProject(fields.project_id),
      this.configStore.read(),
    ]);
    const service = selectProjectService(target.project, fields.service_id);
    assertTrackableProject(target.project, service, target.abilities);
    if (timerResult.error) throw timerResult.error;
    const timer = timerResult.timer;
    const before = this.currentTimerRecord(timer);
    assertGuard(guard, before);
    const rememberedIdentity = timer._segments.at(-1)?.identity_id
      ?? timer._continuedSegments.at(-1)?.identity_id;
    const identity = rememberedIdentity == null
      ? await this.identity()
      : { id: rememberedIdentity };
    const logged = await this.logTimerState(timer, before);
    try {
      const started = await this.startTimerState(fields, {
        identity,
        ...target,
        timezone: config.timezone,
      });
      return receipt(
        "timer-switch",
        [...logged.changes, ...started.changes],
        [...logged.results, ...started.results],
        { log: "confirmed", start: "confirmed" },
      );
    } catch (error) {
      const partialReceipt = receipt(
        "timer-switch",
        logged.changes,
        logged.results,
        { log: "confirmed", start: "failed" },
      );
      throw new CliError("The previous timer logged, but the next timer did not start", {
        code: "TIMER_SWITCH_PARTIAL",
        details: {
          partialReceipt,
          startError: {
            code: error?.code || "UNEXPECTED_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }

  async discardTimer(timerId, { guard } = {}) {
    const timer = await this.guardedActiveTimer(timerId, guard);
    const before = this.currentTimerRecord(timer);
    let confirmedWrites = 0;
    try {
      for (const segment of timer._segments) {
        await this.deleteTimeEntryRecord(segment.id);
        confirmedWrites += 1;
      }
      const deleted = this.requireTracking().remember(canonicalDeleted("active-timer", timer.id));
      return receipt("timer-discard", [{
        scope: recordScope(deleted),
        before: { token: before.token },
        after: { deleted: true },
      }], [deleted]);
    } catch (error) {
      if (confirmedWrites > 0) throw ambiguousMutation(error, "timer-discard");
      throw error;
    }
  }

  activeTimerReceipt(mutationKind, before, timer) {
    const after = this.currentTimerRecord(timer);
    return receipt(mutationKind, [{
      scope: recordScope(after),
      before: { token: before.token },
      after: { record: after },
    }], [after]);
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

  timerSegments(timer) {
    return [...timer._continuedSegments, ...timer._segments];
  }

  timerWithReplacements(timer, replacements) {
    const byId = new Map(replacements.map((segment) => [String(segment.id), segment]));
    const segments = this.timerSegments(timer).map((segment) => {
      const replacement = byId.get(String(segment.id));
      if (!replacement) return segment;
      byId.delete(String(segment.id));
      return {
        ...segment,
        ...replacement,
        timer: replacement.timer ?? segment.timer,
      };
    });
    return this.rememberTimerSegments([...segments, ...byId.values()], timer.id);
  }

  rememberTimerSegments(segments, timerId) {
    const context = this.requireTracking();
    const current = canonicalActiveTimers(segments, {
      observedAt: context.observedAt,
    }).find((candidate) => candidate.id === String(timerId));
    const timer = groupTimerSegments(segments, this.now())
      .find((candidate) => String(candidate.id) === String(timerId));
    if (!current || !timer) {
      throw new CliError("FreshBooks did not return the expected active timer", {
        code: "TIMER_RECONCILIATION_FAILED",
      });
    }
    context.remember(current);
    return timer;
  }
  async guardedTimeEntry(entryId, guard) {
    requireMutationGuard(guard);
    let existing;
    try {
      existing = await this.timeEntry(entryId);
    } catch (error) {
      if (error?.status === 404) {
        assertGuard(guard, canonicalDeleted("time-entry", entryId));
      }
      throw error;
    }
    const context = this.requireTracking();
    const current = context.remember(canonicalTimeEntry(existing, {
      timezone: context.timezone,
    }));
    assertGuard(guard, current);
    return { existing, current };
  }

  async guardedActiveTimer(timerId, guard) {
    let timer;
    requireTimerMutationGuard(timerId, guard);
    try {
      timer = await this.activeTimer(timerId);
    } catch (error) {
      if (error?.code === "TIMER_NOT_ACTIVE") {
        assertGuard(guard, canonicalDeleted("active-timer", timerId));
      }
      throw error;
    }
    assertGuard(guard, this.currentTimerRecord(timer));
    return timer;
  }

  currentTimerRecord(timer) {
    const current = this.requireTracking().get(`active-timer:${String(timer.id)}`);
    if (!current) {
      throw new CliError("Canonical active timer is required", {
        code: "TRACKING_CONTEXT_REQUIRED",
      });
    }
    return current;
  }

  requireTracking() {
    if (!this.trackingContext) {
      throw new CliError("Canonical tracking context is required", {
        code: "TRACKING_CONTEXT_REQUIRED",
      });
    }
    return this.trackingContext;
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
    if (entry?.timer?.id == null) continue;
    const key = Number(entry.timer.id);
    if (!grouped.has(key)) grouped.set(key, new Map());
    grouped.get(key).set(String(entry.id), entry);
  }
  return [...grouped.entries()].flatMap(([timerId, entriesById]) => {
    const segments = [...entriesById.values()];
    segments.sort((left, right) => new Date(left.started_at) - new Date(right.started_at));
    const activeSegments = segments.filter((segment) => segment.is_logged === false);
    if (activeSegments.length === 0) return [];
    const continuedSegments = segments.filter((segment) => segment.is_logged === true);
    const openSegments = activeSegments.filter((segment) => segment.duration == null);
    const current = openSegments.at(-1) || activeSegments.at(-1);
    const continuedSeconds = continuedSegments.reduce(
      (total, segment) => total + Math.max(0, Number(segment.duration) || 0),
      0,
    );
    const elapsed = segments.reduce(
      (total, segment) => total + (segment.duration == null && segment.is_logged === false
        ? elapsedSeconds(segment, now)
        : Math.max(0, Number(segment.duration) || 0)),
      0,
    );
    const timer = {
      id: timerId,
      timerId,
      segmentIds: segments.map((segment) => segment.id),
      activeSegmentIds: activeSegments.map((segment) => segment.id),
      segments: segments.map(presentTimerSegment),
      openSegment: openSegments.length ? presentTimerSegment(openSegments.at(-1)) : null,
      running: openSegments.length > 0,
      isLogged: false,
      startedAt: segments[0]?.started_at,
      continuedSeconds,
      elapsedSeconds: elapsed,
      elapsed: formatDuration(elapsed),
      projectId: current?.project_id,
      clientId: current?.client_id,
      serviceId: current?.service_id,
      note: current?.note,
      billable: current?.billable,
    };
    Object.defineProperties(timer, {
      _segments: { value: activeSegments },
      _continuedSegments: { value: continuedSegments },
      _openSegment: { value: openSegments.at(-1) || null },
    });
    return [timer];
  });
}

function presentTimerSegment(segment) {
  return {
    id: segment.id,
    startedAt: segment.started_at,
    localStartedAt: segment.local_started_at ?? null,
    durationSeconds: segment.duration == null ? null : Math.max(0, Number(segment.duration) || 0),
    running: segment.is_logged === false && segment.duration == null,
    isLogged: segment.is_logged === true,
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

function requireMutationGuard(guard) {
  if (typeof guard === "string" && guard.length > 0) return guard;
  throw new CliError("A semantic guard is required for this mutation", {
    code: "GUARD_REQUIRED",
    exitCode: 2,
  });
}

function requireTimerMutationGuard(timerId, guard) {
  requireMutationGuard(guard);
  if (timerId !== undefined) return;
  throw new CliError("Guarded timer mutations require a canonical active-timer identity", {
    code: "INVALID_ARGUMENT",
    exitCode: 2,
  });
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
