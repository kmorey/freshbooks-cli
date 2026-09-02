import { asCliError } from "./errors.js";

export class Output {
  constructor({ json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
    this.json = json;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  success(data, humanText) {
    if (this.json) {
      this.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, data })}\n`);
    } else if (humanText) {
      this.stdout.write(`${humanText}\n`);
    } else if (data !== undefined) {
      this.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
  }

  error(cause) {
    const error = asCliError(cause);
    if (this.json) {
      this.stderr.write(
        `${JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        })}\n`,
      );
    } else {
      this.stderr.write(`freshbooks: ${error.message}\n`);
    }
    return error.exitCode;
  }
}
