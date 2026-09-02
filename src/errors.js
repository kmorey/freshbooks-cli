export class CliError extends Error {
  constructor(message, { code = "CLI_ERROR", exitCode = 1, details, status, outcomeUnknown = false } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export class ApiError extends CliError {
  constructor(message, { code = "API_ERROR", details, status, outcomeUnknown = false } = {}) {
    super(message, { code, details, status, outcomeUnknown, exitCode: status === 401 ? 4 : 3 });
    this.name = "ApiError";
  }
}

export function asCliError(error) {
  if (error instanceof CliError) return error;
  return new CliError(error instanceof Error ? error.message : String(error), {
    code: "UNEXPECTED_ERROR",
  });
}
