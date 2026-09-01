import { CliError } from "./errors.js";

const BOOLEAN_OPTIONS = new Set([
  "all",
  "billable",
  "force",
  "help",
  "include-unlogged",
  "json",
  "no-browser",
  "version",
  "yes",
]);

export function parseArgs(argv) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const separator = argument.indexOf("=");
    const rawName = argument.slice(2, separator === -1 ? undefined : separator);
    if (!rawName) throw new CliError("Invalid empty option", { code: "INVALID_ARGUMENT" });

    if (rawName.startsWith("no-") && separator === -1 && rawName !== "no-browser") {
      options[toCamelCase(rawName.slice(3))] = false;
      continue;
    }

    const name = toCamelCase(rawName);
    if (separator !== -1) {
      options[name] = argument.slice(separator + 1);
    } else if (BOOLEAN_OPTIONS.has(rawName)) {
      options[name] = true;
    } else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`Option --${rawName} requires a value`, {
          code: "INVALID_ARGUMENT",
          exitCode: 2,
        });
      }
      options[name] = value;
      index += 1;
    }
  }

  return { positionals, options };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

export function requireOption(options, name, flag = name) {
  const value = options[name];
  if (value === undefined || value === "") {
    throw new CliError(`Missing required option --${flag}`, {
      code: "INVALID_ARGUMENT",
      exitCode: 2,
    });
  }
  return value;
}

export function optionalInteger(value, flag) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`--${flag} must be a positive integer`, {
      code: "INVALID_ARGUMENT",
      exitCode: 2,
    });
  }
  return parsed;
}
