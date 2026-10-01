# FreshBooks CLI

A small, dependency-free FreshBooks time-tracking CLI designed for scripts and Omarchy 4 / Quickshell plugins.

> [!IMPORTANT]
> This project is early alpha software and is not affiliated with or endorsed by FreshBooks. Test it with non-critical entries before relying on it for billing records.

The CLI uses FreshBooks' public OAuth 2.0 and time-entry APIs. A timer started here is stored in FreshBooks as an unlogged time entry, so it should also appear in the FreshBooks web and mobile interfaces. FreshBooks remains the source of truth if the computer sleeps or the shell restarts.

## Current capabilities

- OAuth login with automatic, concurrency-safe refresh-token rotation
- Credentials stored in the desktop Secret Service when available
- Business discovery and selection
- Project listing
- FreshBooks-backed timer start, pause, resume, correction, switch, log, and discard
- Time-entry list, create, update, and delete
- Versioned, one-line JSON envelopes for QML and scripts

## Install

On Linux or macOS with Node.js 22 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/kmorey/freshbooks-cli/main/install.sh | sh
freshbooks --help
```

The installer verifies the latest release checksum, installs versioned application files under `~/.local/share/freshbooks-cli`, and places the command at `~/.local/bin/freshbooks`. Running it again upgrades the CLI without touching configuration or credentials.

For an inspect-before-running workflow, pinned versions, custom prefixes, uninstall instructions, Windows/npm installation, and an agent-ready procedure, see [INSTALL.md](INSTALL.md).

## Requirements

- Node.js 22 or newer
- `secret-tool` and a Secret Service-compatible desktop keyring are recommended
- A FreshBooks account and OAuth application

## FreshBooks application setup

Create an application in the [FreshBooks developer hub](https://my.freshbooks.com/#/developer) and grant these scopes:

```text
user:profile:read
user:projects:read
user:clients:read
user:billable_items:read
user:time_entries:read
user:time_entries:write
```

FreshBooks requires an HTTPS redirect URI. For a personal command-line app, a practical value is:

```text
https://localhost/freshbooks/callback
```

The browser will probably show a connection error after authorization because no HTTPS server is listening. Copy the complete URL from the address bar and paste it into the CLI; it contains the short-lived authorization code.

Configure the CLI without placing the secret in shell history:

```bash
export FRESHBOOKS_CLIENT_SECRET='your-client-secret'
./bin/freshbooks.js auth configure \
  --client-id 'your-client-id' \
  --redirect-uri 'https://localhost/freshbooks/callback'
unset FRESHBOOKS_CLIENT_SECRET

./bin/freshbooks.js auth login
./bin/freshbooks.js business list
./bin/freshbooks.js business use 123456
```

If Secret Service cannot be reached—for example, from a terminal without an inherited D-Bus session—the CLI reports the fallback and writes credentials to `~/.config/freshbooks-cli/credentials.json` with mode `0600`. The ordinary non-secret configuration remains in `config.json`. Set `FRESHBOOKS_CREDENTIALS_FILE` to override the fallback path.

## Timer workflow

```bash
freshbooks projects list
freshbooks clients list
freshbooks timer start --project 12345 --service 67890 --note 'Implement time widget'
freshbooks timer status --json
freshbooks timer pause --id 456 --guard GUARD_TOKEN
freshbooks timer resume --id 456 --guard GUARD_TOKEN
freshbooks timer correct --id 456 --duration 1h30m --guard GUARD_TOKEN
freshbooks timer log --id 456 --guard GUARD_TOKEN
```

`timer status` groups Time Entries by timer identity and only exposes groups that still contain an unlogged segment. A pause closes the current unlogged segment; resume adds another segment to the same logical timer. A canonical active timer includes all timer segments, including logged continuation predecessors, while writes remain limited to active segments. `timer start` refuses to create another logical timer when one already exists.

Starting a timer derives client, internal, and billability fields from the selected project and service. Switching logs the current timer before starting the next one:

```bash
freshbooks timer switch --id 456 --guard GUARD_TOKEN --project 23456 --service 78901
```

Discard is destructive and requires both the current guard and explicit confirmation:

```bash
freshbooks timer discard --id 456 --guard GUARD_TOKEN --yes
```

## Time entries

```bash
freshbooks time list --from 2026-09-01 --to 2026-09-02 --json
freshbooks time add --date 2026-09-02 --duration 1h30m --project 12345 --service 67890 --note 'Planning'
freshbooks time update 98765 --guard GUARD_TOKEN --date 2026-09-03 --duration 1h45m --note 'Planning and review'
freshbooks time delete 98765 --guard GUARD_TOKEN --yes
```

Calendar dates use the configured FreshBooks timezone, including daylight-saving transitions. Set `FRESHBOOKS_TIMEZONE` to the account's IANA timezone (for example, `America/Chicago`) when it differs from the machine timezone. Entry create and project/service changes derive client, internal, and billability fields from the selected FreshBooks project service.

## Quickshell contract

Add `--json` to any command. Exactly one JSON object is written to standard output on success. The envelope remains version 1; canonical tracking records and mutation receipts use contract version 2:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "data": {
    "contractVersion": 2,
    "queryKey": "timer-status",
    "coverage": {
      "complete": true,
      "includesDeleted": false,
      "fromDate": null,
      "toDate": null
    },
    "records": [
      {
        "contractVersion": 2,
        "kind": "active-timer",
        "id": "456",
        "exists": true,
        "segments": [
          {
            "contractVersion": 2,
            "kind": "timer-segment",
            "id": "98765",
            "timerId": "456",
            "exists": true,
            "startedAt": "2026-09-01T14:00:00.000Z",
            "durationSeconds": null,
            "running": true,
            "logged": false,
            "token": "segment-semantic-token"
          }
        ],
        "state": "running",
        "elapsedAnchor": {
          "closedSeconds": 1800,
          "runningStartedAt": "2026-09-01T14:00:00.000Z",
          "observedAt": "2026-09-01T14:12:05.000Z"
        },
        "projectId": "12345",
        "clientId": "23456",
        "serviceId": "67890",
        "note": "Implement time widget",
        "billable": true,
        "token": "active-timer-semantic-token"
      }
    ]
  }
}
```

Canonical `time-entry` records use string `id`, `exists`, `localDate`, `startedAt`, `durationSeconds`, project/client/service IDs, note, billable/billed flags, and a semantic `token`. Canonical `active-timer` records use string `id`, canonical `segments`, `state`, `elapsedAnchor`, project/client/service IDs, note, billability, and a semantic `token`. Deleted records are `{ "contractVersion": 2, "kind": "...", "id": "...", "exists": false, "token": null }`.

Every mutation of an existing time entry or timer requires `--guard TOKEN`, using the `token` from the canonical record the caller acted on. A stale token fails with `GUARD_REJECTED` and includes the complete current canonical record. Successful mutations return a version-2 receipt with:

- `mutationKind`: the completed operation;
- `changes`: scopes with the prior token or absence marker and the resulting record or deletion marker;
- `results`: canonical records callers can apply immediately;
- `phase`: `null` except for multi-phase operations.

Timer switch receipts use `phase: { "log": "confirmed", "start": "confirmed" }`. If logging succeeds but starting fails, `TIMER_SWITCH_PARTIAL` includes `details.partialReceipt` with `phase: { "log": "confirmed", "start": "failed" }` plus `details.startError`. Callers must apply that partial receipt before presenting recovery.

Successful mutations do not issue confirmation GETs. Their receipts are constructed from the guarded discovery record, confirmed write responses, and command-scoped tracking context. Poll explicitly when a later observation is needed.

`freshbooks diagnostics status --json` advertises the release contract:

```json
{
  "canonicalContractVersion": 2,
  "commandBudgetsMs": {
    "read": 64000,
    "singleWrite": 128000,
    "multiSegment": 320000,
    "log": 192000,
    "switch": 320000
  }
}
```

The diagnostics capability list includes `canonical-tracking-v2` and `mutation-receipts`. Treat the operation-aware budgets as maximum CLI coordination deadlines; they account for the 15-second network timeout, one authentication replay, bounded rate-limit waits, and each workflow's sequential request ceiling.

Errors are written to standard error with a non-zero exit status:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Run `freshbooks auth login` first"
  }
}
```

Recommended plugin behavior:

- Poll `freshbooks timer status --json` every 15–30 seconds and immediately after actions that need a fresh observation.
- Apply successful and partial mutation receipts before polling again.
- Advance a running duration locally from `elapsedAnchor` instead of calling the API every second.
- Treat `API_TIMEOUT` with `outcomeUnknown: true` as ambiguous and refresh before allowing another mutation.
- For in-popup onboarding, pass the OAuth client secret with `auth configure --client-secret-stdin --json` and the returned authorization URL with `auth login --code-stdin --json`.
- Open the URL returned by `auth url --json` in the user's browser; never render or log its state parameter.
- Do not read or copy the keyring contents into QML.

Omarchy plugins run unsandboxed inside the long-lived shell, so keep the QML wrapper narrow and invoke only this executable with fixed argument arrays.

## Security and local data

- OAuth client secrets, access tokens, and rotating refresh tokens are stored in Secret Service when it is available.
- When Secret Service is unavailable, the CLI clearly reports its use of the mode-`0600` credential file.
- Non-secret configuration, including the selected business ID, is stored in `~/.config/freshbooks-cli/config.json`.
- The CLI never writes credentials or API responses into this repository.
- Avoid running commands with secrets directly in command arguments because shell history and process listings may retain them.

See [SECURITY.md](SECURITY.md) for vulnerability and accidental-disclosure guidance.

## Development

```bash
npm install
npm test
npm run check
```

The test suite uses only local mocks and never touches a FreshBooks account.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## API references

- [FreshBooks authentication](https://www.freshbooks.com/api/authentication)
- [FreshBooks identity model](https://www.freshbooks.com/api/identity_model)
- [FreshBooks time entries](https://www.freshbooks.com/api/time_entries)
- [FreshBooks scopes](https://www.freshbooks.com/api/scopes)
- [Omarchy shell plugin contract](https://omarchy.org/manual/shell-plugins/)
