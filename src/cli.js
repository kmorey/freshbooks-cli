import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { parseArgs, optionalInteger, requireOption } from "./args.js";
import { ConfigStore } from "./config.js";
import { SecretStore } from "./secrets.js";
import { FreshBooksClient } from "./api.js";
import { FreshBooksService } from "./freshbooks.js";
import { authorizationUrl, exchangeAuthorizationCode } from "./auth.js";
import { Output } from "./output.js";
import { parseDate, parseDuration } from "./format.js";
import { CliError } from "./errors.js";
import { runProcess } from "./process.js";

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require("../package.json");

export async function run(argv, dependencies = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return new Output({ json: argv.includes("--json"), ...dependencies }).error(error);
  }

  const output = dependencies.output || new Output({ json: parsed.options.json, ...dependencies });
  try {
    if (parsed.options.version) {
      output.success({ version: PACKAGE_VERSION }, PACKAGE_VERSION);
      return 0;
    }
    if (parsed.options.help || parsed.positionals.length === 0) {
      output.success({ help: HELP }, HELP);
      return 0;
    }

    const configStore = dependencies.configStore || new ConfigStore({ environment: dependencies.environment });
    const secretStore =
      dependencies.secretStore || new SecretStore({ environment: dependencies.environment });
    const client =
      dependencies.client ||
      new FreshBooksClient({ configStore, secretStore, fetcher: dependencies.fetcher });
    const service =
      dependencies.service || new FreshBooksService({ client, configStore, now: dependencies.now });
    const [group, action, argument] = parsed.positionals;

    if (group === "auth") {
      return await authCommand({ action, options: parsed.options, output, configStore, secretStore, dependencies });
    }
    if (group === "business") {
      return await businessCommand({ action, argument, output, service });
    }
    if (group === "projects") {
      return await projectsCommand({ action, options: parsed.options, output, service });
    }
    if (group === "timer") {
      return await timerCommand({ action, argument, options: parsed.options, output, service });
    }
    if (group === "time") {
      return await timeCommand({ action, argument, options: parsed.options, output, service });
    }

    throw new CliError(`Unknown command: ${parsed.positionals.join(" ")}`, {
      code: "UNKNOWN_COMMAND",
      exitCode: 2,
    });
  } catch (error) {
    return output.error(error);
  }
}

async function authCommand({ action, options, output, configStore, secretStore, dependencies }) {
  const config = await configStore.read();
  if (action === "configure") {
    const existingSecrets = await secretStore.read(config.profile);
    const clientId = options.clientId || config.clientId;
    const clientSecret = options.clientSecret || existingSecrets.clientSecret;
    const redirectUri = options.redirectUri || config.redirectUri;
    if (!clientId) throw new CliError("Missing --client-id or FRESHBOOKS_CLIENT_ID", { exitCode: 2 });
    if (!clientSecret) {
      throw new CliError("Missing --client-secret or FRESHBOOKS_CLIENT_SECRET", { exitCode: 2 });
    }
    if (!redirectUri) {
      throw new CliError("Missing --redirect-uri or FRESHBOOKS_REDIRECT_URI", { exitCode: 2 });
    }
    assertHttpsRedirect(redirectUri);
    await configStore.update({ clientId, redirectUri });
    await secretStore.write(config.profile, { ...existingSecrets, clientSecret });
    output.success(
      {
        configured: true,
        clientId,
        redirectUri,
        profile: config.profile,
        credentialStore: secretStore.backend,
        warning: secretStore.warning,
      },
      ["FreshBooks OAuth application configured.", secretStore.warning].filter(Boolean).join("\n"),
    );
    return 0;
  }

  if (action === "url") {
    const result = authorizationUrl(config);
    output.success(result, result.url);
    return 0;
  }

  if (action === "login") {
    const { url } = authorizationUrl(config);
    let code = options.code;
    if (!code) {
      if (options.json) {
        throw new CliError("Use `auth login --code <code-or-redirect-url> --json` for non-interactive login", {
          code: "AUTH_CODE_REQUIRED",
          exitCode: 2,
        });
      }
      defaultStdout.write(`Open this URL and authorize the application:\n\n${url}\n\n`);
      if (!options.noBrowser) {
        await (dependencies.openBrowser || openBrowser)(url).catch(() => {});
      }
      const prompt = dependencies.prompt || promptForCode;
      code = await prompt("Paste the authorization code or redirected URL: ");
    }
    const secrets = await secretStore.read(config.profile);
    const tokens = await exchangeAuthorizationCode({
      config,
      secrets,
      code,
      fetcher: dependencies.fetcher,
    });
    await secretStore.write(config.profile, { ...secrets, ...tokens });
    output.success(
      {
        authenticated: true,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        credentialStore: secretStore.backend,
        warning: secretStore.warning,
      },
      ["Authenticated with FreshBooks.", secretStore.warning].filter(Boolean).join("\n"),
    );
    return 0;
  }

  if (action === "status") {
    const secrets = await secretStore.read(config.profile);
    const authenticated = Boolean(secrets.accessToken);
    output.success(
      {
        configured: Boolean(config.clientId && config.redirectUri),
        authenticated,
        profile: config.profile,
        credentialStore: secretStore.backend,
        warning: secretStore.warning,
        expiresAt: secrets.expiresAt,
        businessId: config.businessId,
      },
      authenticated ? `Authenticated (profile: ${config.profile}).` : "Not authenticated.",
    );
    return authenticated ? 0 : 4;
  }

  if (action === "logout") {
    await secretStore.clear(config.profile);
    output.success({ authenticated: false }, "FreshBooks credentials removed from Secret Service.");
    return 0;
  }
  throw unknownAction("auth", action);
}

async function businessCommand({ action, argument, output, service }) {
  if (action === "list") {
    const businesses = await service.businesses();
    output.success(
      businesses,
      businesses.map((business) => `${business.id}\t${business.name}\t${business.role}`).join("\n") ||
        "No FreshBooks businesses found.",
    );
    return 0;
  }
  if (action === "use") {
    const id = optionalInteger(argument, "business-id");
    if (!id) throw new CliError("Usage: freshbooks business use <id>", { exitCode: 2 });
    const business = await service.selectBusiness(id);
    output.success(business, `Using ${business.name} (${business.id}).`);
    return 0;
  }
  throw unknownAction("business", action);
}

async function projectsCommand({ action, options, output, service }) {
  if (action !== "list") throw unknownAction("projects", action);
  const projects = await service.projects({ all: options.all });
  output.success(
    projects,
    projects.map((project) => `${project.id}\t${project.title || project.name}`).join("\n") ||
      "No projects found.",
  );
  return 0;
}

async function timerCommand({ action, argument, options, output, service }) {
  const timerId = optionalInteger(argument ?? options.id, "id");
  if (action === "status") {
    const timers = await service.activeTimers();
    output.success(
      { active: timers.length > 0, timers },
      timers.length
        ? timers
            .map(
              (timer) =>
                `${timer.running ? "running" : "paused"}\t${timer.elapsed}\t${timer.note || "No note"} (#${timer.id})`,
            )
            .join("\n")
        : "No FreshBooks timer is active.",
    );
    return 0;
  }
  if (action === "start") {
    const startedAt = parseDate(options.startedAt, "started-at");
    const timer = await service.startTimer(
      {
        project_id: optionalInteger(options.project, "project"),
        client_id: optionalInteger(options.client, "client"),
        service_id: optionalInteger(options.service, "service"),
        note: options.note,
        billable: options.billable,
        started_at: startedAt?.toISOString(),
      },
      { force: options.force },
    );
    output.success(timer, `Started FreshBooks timer #${timer.id}.`);
    return 0;
  }
  if (action === "log") {
    const entry = await service.logTimer(timerId);
    output.success(entry, `Logged ${entry.elapsed} to FreshBooks (#${entry.id}).`);
    return 0;
  }
  if (action === "pause") {
    const timer = await service.pauseTimer(timerId);
    output.success(timer, `Paused FreshBooks timer #${timer.id}.`);
    return 0;
  }
  if (action === "resume") {
    const timer = await service.resumeTimer(timerId);
    output.success(timer, `Resumed FreshBooks timer #${timer.id}.`);
    return 0;
  }
  if (action === "correct") {
    const duration = parseDuration(requireOption(options, "duration"));
    const timer = await service.correctTimer(timerId, duration);
    output.success(timer, `Corrected FreshBooks timer #${timer.id} to ${timer.elapsed}.`);
    return 0;
  }
  if (action === "update") {
    if (options.note === undefined) {
      throw new CliError("Provide --note to update a timer", { exitCode: 2 });
    }
    const timer = await service.updateTimer(timerId, { note: options.note });
    output.success(timer, `Updated FreshBooks timer #${timer.id}.`);
    return 0;
  }
  if (action === "switch") {
    const result = await service.switchTimer(timerId, {
      project_id: optionalInteger(options.project, "project"),
      client_id: optionalInteger(options.client, "client"),
      service_id: optionalInteger(options.service, "service"),
      note: options.note,
    });
    output.success(result, `Switched to FreshBooks timer #${result.timer.id}.`);
    return 0;
  }
  if (action === "discard") {
    if (!options.yes) {
      throw new CliError("Discarding a timer is permanent; pass --yes to confirm", {
        code: "CONFIRMATION_REQUIRED",
        exitCode: 2,
      });
    }
    const result = await service.discardTimer(timerId);
    output.success(result, `Discarded FreshBooks timer #${result.id}.`);
    return 0;
  }
  throw unknownAction("timer", action);
}

async function timeCommand({ action, argument, options, output, service }) {
  const entryId = optionalInteger(argument, "entry-id");
  if (action === "list") {
    const from = parseDate(options.from, "from");
    const to = parseDate(options.to, "to");
    const entries = await service.listTimeEntries({
      started_from: from?.toISOString(),
      started_to: to?.toISOString(),
      project_id: optionalInteger(options.project, "project"),
      include_unlogged: options.includeUnlogged,
    });
    output.success(
      entries,
      entries
        .map((entry) => `${entry.id}\t${entry.duration || 0}s\t${entry.note || ""}`)
        .join("\n") || "No time entries found.",
    );
    return 0;
  }
  if (action === "add") {
    const duration = parseDuration(requireOption(options, "duration"));
    const startedAt = parseDate(options.startedAt || new Date().toISOString(), "started-at");
    const entry = await service.createTimeEntry({
      is_logged: true,
      duration,
      started_at: startedAt.toISOString(),
      project_id: optionalInteger(options.project, "project"),
      client_id: optionalInteger(options.client, "client"),
      service_id: optionalInteger(options.service, "service"),
      note: options.note,
      billable: options.billable,
    });
    output.success(entry, `Created FreshBooks time entry #${entry.id}.`);
    return 0;
  }
  if (action === "update") {
    if (!entryId) throw new CliError("Usage: freshbooks time update <id> [options]", { exitCode: 2 });
    const patch = {
      duration: options.duration === undefined ? undefined : parseDuration(options.duration),
      started_at: parseDate(options.startedAt, "started-at")?.toISOString(),
      project_id: optionalInteger(options.project, "project"),
      client_id: optionalInteger(options.client, "client"),
      service_id: optionalInteger(options.service, "service"),
      note: options.note,
      billable: options.billable,
    };
    if (Object.values(patch).every((value) => value === undefined)) {
      throw new CliError("Provide at least one field to update", { exitCode: 2 });
    }
    const entry = await service.updateTimeEntry(entryId, patch);
    output.success(entry, `Updated FreshBooks time entry #${entry.id}.`);
    return 0;
  }
  if (action === "delete") {
    if (!entryId) throw new CliError("Usage: freshbooks time delete <id> --yes", { exitCode: 2 });
    if (!options.yes) {
      throw new CliError("Deleting a time entry is permanent; pass --yes to confirm", {
        code: "CONFIRMATION_REQUIRED",
        exitCode: 2,
      });
    }
    const result = await service.deleteTimeEntry(entryId);
    output.success(result, `Deleted FreshBooks time entry #${entryId}.`);
    return 0;
  }
  throw unknownAction("time", action);
}

function unknownAction(group, action) {
  return new CliError(`Unknown ${group} command: ${action || "(missing)"}`, {
    code: "UNKNOWN_COMMAND",
    exitCode: 2,
  });
}

function assertHttpsRedirect(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("--redirect-uri must be a valid HTTPS URL", { exitCode: 2 });
  }
  if (url.protocol !== "https:") {
    throw new CliError("FreshBooks requires an HTTPS redirect URI", { exitCode: 2 });
  }
}

async function openBrowser(url) {
  await runProcess("xdg-open", [url]);
}

async function promptForCode(question) {
  const readline = createInterface({ input: defaultStdin, output: defaultStdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

const HELP = `freshbooks — FreshBooks time tracking from the shell

Usage:
  freshbooks auth configure --client-id ID --redirect-uri HTTPS_URL
  freshbooks auth login [--no-browser] [--code CODE_OR_URL]
  freshbooks auth status
  freshbooks auth logout
  freshbooks business list
  freshbooks business use ID
  freshbooks projects list [--all]
  freshbooks timer status
  freshbooks timer start --project ID --service ID [--note TEXT]
  freshbooks timer pause [--id TIMER_ID]
  freshbooks timer resume [--id TIMER_ID]
  freshbooks timer correct --duration SECONDS [--id TIMER_ID]
  freshbooks timer update --note TEXT [--id TIMER_ID]
  freshbooks timer log [--id TIMER_ID]
  freshbooks timer switch --project ID --service ID [--id TIMER_ID]
  freshbooks timer discard [--id TIMER_ID] --yes
  freshbooks time list [--from DATE] [--to DATE] [--project ID]
  freshbooks time add --duration 1h30m [--started-at DATE] [--project ID] [--note TEXT]
  freshbooks time update ENTRY_ID [--duration 45m] [--note TEXT]
  freshbooks time delete ENTRY_ID --yes

Options:
  --json       Emit one stable JSON object for Quickshell and scripts
  --help       Show this help
  --version    Show the installed version

Environment overrides:
  FRESHBOOKS_CLIENT_ID, FRESHBOOKS_CLIENT_SECRET, FRESHBOOKS_REDIRECT_URI
  FRESHBOOKS_ACCESS_TOKEN, FRESHBOOKS_REFRESH_TOKEN, FRESHBOOKS_TOKEN_EXPIRES_AT
  FRESHBOOKS_BUSINESS_ID, FRESHBOOKS_PROFILE`;
