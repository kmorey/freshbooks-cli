# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow under the repository's **Security** tab when available. Do not open a public issue containing credentials, OAuth authorization codes, tokens, account identifiers, or private FreshBooks data.

If a secret is exposed, revoke or rotate it in FreshBooks immediately before reporting the code issue. Removing a secret from the latest commit does not remove it from Git history.

## Credential storage

The preferred backend is the desktop Secret Service. When it is unavailable, the CLI reports that it is using `~/.config/freshbooks-cli/credentials.json` and enforces mode `0600`. Anyone able to act as the local user may still read that file, so protect the user account and filesystem accordingly.

Environment-variable credentials are supported for automation. Keep them out of shell history, process arguments, logs, crash reports, and committed environment files.

## Supported versions

Until the project reaches a stable release, security fixes are applied only to the latest revision of the default branch.
