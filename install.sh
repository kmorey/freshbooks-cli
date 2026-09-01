#!/bin/sh

set -eu

REPOSITORY="kmorey/freshbooks-cli"
MINIMUM_NODE_MAJOR=22
DEFAULT_PREFIX="${HOME}/.local"
prefix="${FRESHBOOKS_CLI_PREFIX:-$DEFAULT_PREFIX}"
requested_version="${FRESHBOOKS_CLI_VERSION:-latest}"
uninstall=false

usage() {
  cat <<'EOF'
Install or upgrade freshbooks-cli for the current user.

Usage:
  install.sh [--version VERSION] [--prefix PATH]
  install.sh --uninstall [--prefix PATH]

Options:
  --version VERSION  Install a release such as v0.1.0 (default: latest)
  --prefix PATH      Install under PATH/bin and PATH/share (default: ~/.local)
  --uninstall        Remove the command and installed application versions
  --help             Show this help

Environment:
  FRESHBOOKS_CLI_VERSION           Alternative to --version
  FRESHBOOKS_CLI_PREFIX            Alternative to --prefix
  FRESHBOOKS_CLI_RELEASE_BASE_URL  Override the release URL (testing/mirrors)
EOF
}

fail() {
  printf 'freshbooks installer: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value"
      requested_version="$2"
      shift 2
      ;;
    --prefix)
      [ "$#" -ge 2 ] || fail "--prefix requires a value"
      prefix="$2"
      shift 2
      ;;
    --uninstall)
      uninstall=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

case "$prefix" in
  ""|/|"$HOME") fail "refusing unsafe installation prefix: $prefix" ;;
  /*) ;;
  *) fail "installation prefix must be an absolute path: $prefix" ;;
esac

install_root="$prefix/share/freshbooks-cli"
versions_root="$install_root/versions"
current_link="$install_root/current"
bin_dir="$prefix/bin"
command_link="$bin_dir/freshbooks"
wrapper_marker="# managed by freshbooks-cli installer"

is_managed_command() {
  if [ -L "$command_link" ]; then
    managed_target=$(readlink "$command_link" || true)
    case "$managed_target" in
      "$install_root"/*) return 0 ;;
    esac
  elif [ -f "$command_link" ] && grep -qF "$wrapper_marker" "$command_link"; then
    return 0
  fi
  return 1
}

require_command grep

if [ "$uninstall" = true ]; then
  if [ -e "$command_link" ] || [ -L "$command_link" ]; then
    is_managed_command || fail "$command_link is not managed by this installer"
    rm "$command_link"
  fi

  if [ -d "$install_root" ]; then
    rm -rf "$install_root"
  fi
  printf 'Removed freshbooks-cli. Configuration and credentials were preserved.\n'
  exit 0
fi

require_command node
require_command curl
require_command tar

node_major=$(node -p 'process.versions.node.split(".")[0]')
case "$node_major" in
  ''|*[!0-9]*) fail "could not determine the installed Node.js version" ;;
esac
[ "$node_major" -ge "$MINIMUM_NODE_MAJOR" ] || \
  fail "Node.js $MINIMUM_NODE_MAJOR or newer is required (found $(node --version))"

if command -v sha256sum >/dev/null 2>&1; then
  checksum_command=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  checksum_command=shasum
else
  fail "sha256sum or shasum is required to verify the release"
fi

if [ -n "${FRESHBOOKS_CLI_RELEASE_BASE_URL:-}" ]; then
  release_base=${FRESHBOOKS_CLI_RELEASE_BASE_URL%/}
elif [ "$requested_version" = latest ]; then
  release_base="https://github.com/$REPOSITORY/releases/latest/download"
else
  case "$requested_version" in
    v*) release_tag="$requested_version" ;;
    *) release_tag="v$requested_version" ;;
  esac
  release_base="https://github.com/$REPOSITORY/releases/download/$release_tag"
fi

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/freshbooks-cli.XXXXXX")
staged_install=""
cleanup() {
  rm -rf "$temporary_dir"
  if [ -n "$staged_install" ] && [ -d "$staged_install" ]; then
    rm -rf "$staged_install"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

archive="$temporary_dir/freshbooks-cli.tar.gz"
checksum="$temporary_dir/freshbooks-cli.tar.gz.sha256"
extracted="$temporary_dir/package"

printf 'Downloading freshbooks-cli (%s)...\n' "$requested_version"
curl -fsSL "$release_base/freshbooks-cli.tar.gz" -o "$archive"
curl -fsSL "$release_base/freshbooks-cli.tar.gz.sha256" -o "$checksum"

if [ "$checksum_command" = sha256sum ]; then
  (cd "$temporary_dir" && sha256sum -c freshbooks-cli.tar.gz.sha256 >/dev/null)
else
  (cd "$temporary_dir" && shasum -a 256 -c freshbooks-cli.tar.gz.sha256 >/dev/null)
fi

mkdir "$extracted"
tar -xzf "$archive" -C "$extracted" --strip-components=1
[ -f "$extracted/package.json" ] || fail "release archive is missing package.json"
[ -x "$extracted/bin/freshbooks.js" ] || fail "release archive is missing the executable"

package_version=$(node -e \
  'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' \
  "$extracted/package.json")
[ -n "$package_version" ] || fail "release archive has no package version"
case "$package_version" in
  .*|*[!A-Za-z0-9._-]*) fail "release archive has an unsafe package version" ;;
esac

if [ "$requested_version" != latest ]; then
  expected_version=${requested_version#v}
  [ "$package_version" = "$expected_version" ] || \
    fail "requested $expected_version but release contains $package_version"
fi

destination="$versions_root/$package_version"
mkdir -p "$versions_root" "$bin_dir"

if [ ! -d "$destination" ]; then
  staged_install="$versions_root/.$package_version.$$"
  mkdir "$staged_install"
  cp -R "$extracted/." "$staged_install/"
  mv "$staged_install" "$destination"
  staged_install=""
fi

[ -x "$destination/bin/freshbooks.js" ] || fail "$destination is incomplete"

if [ -e "$command_link" ] || [ -L "$command_link" ]; then
  is_managed_command || fail "$command_link already exists and is not managed by this installer"
fi
if [ -e "$current_link" ] && [ ! -L "$current_link" ]; then
  fail "$current_link exists and is not managed by this installer"
fi

ln -sfn "$destination" "$current_link"
wrapper_temporary="$bin_dir/.freshbooks.$$"
node -e '
  const fs = require("fs");
  const quote = value => `\x27${value.replaceAll("\x27", "\x27\\\x27\x27")}\x27`;
  const contents = [
    "#!/bin/sh",
    "# managed by freshbooks-cli installer",
    `exec node ${quote(process.argv[1])} "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(process.argv[2], contents, { mode: 0o755 });
' "$current_link/bin/freshbooks.js" "$wrapper_temporary"
chmod 755 "$wrapper_temporary"
mv -f "$wrapper_temporary" "$command_link"

"$command_link" --help >/dev/null
"$command_link" --version >/dev/null

printf 'Installed freshbooks-cli %s to %s\n' "$package_version" "$destination"
printf 'Command: %s\n' "$command_link"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add %s to PATH before running freshbooks.\n' "$bin_dir" ;;
esac
