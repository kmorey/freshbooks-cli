# Agent guide

## Purpose

Maintain a small, dependency-free Node.js CLI for FreshBooks time tracking and shell integrations. Preserve a stable machine-readable interface for Quickshell consumers.

## Working loop

1. Read the affected command path in `src/cli.js`, then follow calls into `src/freshbooks.js`, `src/api.js`, and the auth/config stores.
2. Add or update a deterministic local test before changing behavior. Tests must use fakes or local HTTP fixtures; live FreshBooks accounts are outside the automated test boundary.
3. Run `npm test` and `npm run check`. Completion requires both commands to pass.
4. Scan changed files for credentials, account identifiers, company/client/project names, emails, and captured API payloads before committing.

## Invariants

- Keep runtime dependencies at zero unless a dependency materially reduces security or protocol risk.
- Keep `--json` output to one envelope: `{ "ok": true, "data": ... }` on stdout or `{ "ok": false, "error": ... }` on stderr. Preserve machine-readable error codes and non-zero failure exits.
- Treat FreshBooks refresh tokens as one-time-use values. Refresh under the cross-process lock and persist the returned access/refresh pair atomically.
- Keep a credential profile on one backend. A file-backed profile stays file-backed across graphical and non-graphical sessions so token rotation cannot split state.
- Store fallback credentials only in the configured external credential file with mode `0600`; store no secrets or live API responses in the repository.
- Keep timer polling bounded. `include_unlogged=true` adds timers to ordinary time-entry results, so status checks fetch one page and filter locally.
- Preserve the existing time entry's required fields on updates; FreshBooks PUT requests are not reliable partial updates.
- Omit `Content-Type` on GET requests. Send JSON content type only when a request has a JSON body.
- Require explicit confirmation for destructive time-entry or timer deletion.

## Public-repository hygiene

Use synthetic names and identifiers in documentation, fixtures, snapshots, and error examples. Before every public push, search for high-entropy strings and any values observed during live validation. Credential files live under the user's config directory and remain outside this repository.

## Architecture

- `bin/freshbooks.js`: executable entry point.
- `src/cli.js`: argument dispatch, human output, and JSON command contract.
- `src/freshbooks.js`: business rules and FreshBooks resource workflows.
- `src/api.js`: authenticated HTTP calls, retries, and token refresh coordination.
- `src/auth.js`: OAuth authorization-code and refresh exchanges.
- `src/config.js` / `src/secrets.js`: non-secret configuration and credential backends.
- `test/`: local deterministic regression coverage.
