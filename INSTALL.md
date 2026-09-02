# Install freshbooks-cli

## Fast path

Requirements: Linux or macOS, Node.js 22+, `curl`, `tar`, and either `sha256sum` or `shasum`.

```bash
curl -fsSL https://raw.githubusercontent.com/kmorey/freshbooks-cli/main/install.sh | sh
freshbooks --help
```

The user-local installation needs no `sudo`. Application versions live in `~/.local/share/freshbooks-cli`; the command lives at `~/.local/bin/freshbooks`. Configuration and credentials remain under `~/.config/freshbooks-cli` and survive upgrades or uninstall.

If `freshbooks` is not found after installation, add the bin directory to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Inspect before running

```bash
installer=$(mktemp)
curl -fsSL https://raw.githubusercontent.com/kmorey/freshbooks-cli/main/install.sh -o "$installer"
less "$installer"
sh "$installer"
rm "$installer"
```

## Version, upgrade, and uninstall

Running the installer again upgrades to the latest GitHub release. Pin a release or choose another user-writable prefix when needed:

```bash
sh install.sh --version v0.2.0
sh install.sh --prefix "$HOME/.local"
```

Remove application files while preserving OAuth configuration and credentials:

```bash
curl -fsSL https://raw.githubusercontent.com/kmorey/freshbooks-cli/main/install.sh | sh -s -- --uninstall
```

The installer refuses to replace a `freshbooks` command it does not manage.

## npm / Windows alternative

Any platform with Node.js 22+, npm, and Git can install from GitHub:

```bash
npm install --global github:kmorey/freshbooks-cli#v0.2.0
freshbooks --help
```

Global npm permissions and command locations follow the local Node/npm installation.

## Agent procedure

Use this sequence when an agent is installing the CLI on someone else's machine:

1. Check `node --version`; require Node.js 22 or newer. If it is missing, use the machine's existing version manager or ask before changing system packages.
2. Check that `curl`, `tar`, and `sha256sum` or `shasum` are available.
3. Download `install.sh` to a temporary file, inspect it, and run it without `sudo`.
4. Ensure `~/.local/bin` is on `PATH`, then run `freshbooks --version` and `freshbooks --help`.
5. Report the installed version and command path. Installation is complete only when the help command exits successfully.
6. Configure OAuth only when requested. Have the user provide `FRESHBOOKS_CLIENT_SECRET` through their own shell environment; keep it out of chat, command arguments, logs, and repository files.

The installer downloads `freshbooks-cli.tar.gz` and its SHA-256 file from the selected GitHub release, verifies the checksum before extraction, and switches the `current` installation only after a complete version is staged.
