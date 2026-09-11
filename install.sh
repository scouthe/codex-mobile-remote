#!/usr/bin/env bash
set -Eeuo pipefail

# Codex Remote Linux installer.
#
# The installer owns only ~/.local/share/codexapp, ~/.local/bin/codexapp and
# the user's codexapp-5900 systemd unit. It deliberately never writes to
# CODEX_HOME, auth.json, config.toml, or the official Codex installation.

APP_NAME="codexapp"
REPOSITORY="${CODEXAPP_REPOSITORY:-scouthe/codex-mobile-remote}"
VERSION="${CODEXAPP_VERSION:-latest}"
RELEASE_BASE_URL="${CODEXAPP_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases}"
PORT="${CODEXAPP_PORT:-5900}"
INSTALL_ROOT="${CODEXAPP_INSTALL_ROOT:-${HOME}/.local/share/${APP_NAME}}"
BIN_DIR="${CODEXAPP_BIN_DIR:-${HOME}/.local/bin}"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
UNIT_NAME="${APP_NAME}-5900.service"
SKIP_SERVICE="${CODEXAPP_SKIP_SERVICE:-0}"

info() { printf '[codexapp] %s\n' "$*"; }
fail() { printf '[codexapp] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Install Codex Remote on Linux.

Environment overrides:
  CODEXAPP_VERSION        Release tag (default: latest)
  CODEXAPP_RELEASE_BASE_URL  Release base URL for a mirror (optional)
  CODEXAPP_ARCHIVE        Local release archive, for offline installation
  CODEXAPP_SHA256         Expected SHA-256 for CODEXAPP_ARCHIVE/download
  CODEXAPP_PORT            Web port (default: 5900)
  CODEXAPP_INSTALL_ROOT   Install directory (default: ~/.local/share/codexapp)
  CODEXAPP_SKIP_SERVICE   Set to 1 to install without starting systemd

The installer preserves the official Codex configuration in $CODEX_HOME.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1 (use --help)" ;;
  esac
done

[[ "${OSTYPE:-}" == linux* ]] || fail "this installer supports Linux only"
[[ -n "${HOME:-}" && -d "$HOME" ]] || fail 'HOME is not set to a valid directory'

command -v tar >/dev/null 2>&1 || fail 'tar is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  fail 'Node.js 18 or newer is required. Install Node.js, then run this installer again.'
fi
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR >= 18 )) || fail "Node.js 18 or newer is required (found ${NODE_MAJOR:-unknown})"

CODEX_BIN="$(command -v codex || true)"
[[ -n "$CODEX_BIN" ]] || fail 'official Codex CLI was not found in PATH; install/authenticate Codex first'

ARCHIVE="${CODEXAPP_ARCHIVE:-}"
TEMP_DIR=""
cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -z "$ARCHIVE" ]]; then
  command -v curl >/dev/null 2>&1 || fail 'curl is required when downloading a release'
  case "$(uname -m)" in
    x86_64|amd64) RELEASE_ARCH='amd64' ;;
    aarch64|arm64) RELEASE_ARCH='arm64' ;;
    *) fail "unsupported Linux architecture: $(uname -m)" ;;
  esac
  if [[ "$VERSION" == latest ]]; then
    ARCHIVE_URL="${RELEASE_BASE_URL}/latest/download/${APP_NAME}-linux-${RELEASE_ARCH}.tar.gz"
  else
    ARCHIVE_URL="${RELEASE_BASE_URL}/download/${VERSION}/${APP_NAME}-linux-${RELEASE_ARCH}.tar.gz"
  fi
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${APP_NAME}-install.XXXXXX")"
  ARCHIVE="${TEMP_DIR}/${APP_NAME}.tar.gz"
  info "downloading ${ARCHIVE_URL}"
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$ARCHIVE_URL" --output "$ARCHIVE"
  CHECKSUMS="${TEMP_DIR}/SHA256SUMS"
  if curl --fail --location --retry 2 --proto '=https' --tlsv1.2 \
    "${ARCHIVE_URL%/*}/SHA256SUMS" --output "$CHECKSUMS" >/dev/null 2>&1; then
    EXPECTED_SHA256="$(awk -v file="$(basename "$ARCHIVE_URL")" '$2 == file { print $1; exit }' "$CHECKSUMS")"
    if [[ -n "$EXPECTED_SHA256" ]]; then
      ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
      [[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] || fail 'release checksum does not match SHA256SUMS'
      info 'release checksum verified'
    else
      info 'release checksum entry not found; continuing without verification'
    fi
  else
    info 'release does not provide SHA256SUMS; continuing without checksum verification'
  fi
fi

[[ -f "$ARCHIVE" ]] || fail "release archive not found: $ARCHIVE"
if [[ -n "${CODEXAPP_SHA256:-}" ]]; then
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  [[ "$ACTUAL_SHA256" == "$CODEXAPP_SHA256" ]] || fail 'release checksum does not match CODEXAPP_SHA256'
fi

RELEASE_ID="$VERSION"
if [[ "$RELEASE_ID" == latest ]]; then
  RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
fi
RELEASE_DIR="${INSTALL_ROOT}/releases/${RELEASE_ID}"
mkdir -p "$RELEASE_DIR" "$BIN_DIR"
tar -xzf "$ARCHIVE" -C "$RELEASE_DIR"
[[ -f "$RELEASE_DIR/dist-cli/index.js" ]] || fail 'release archive is missing dist-cli/index.js'
[[ -f "$RELEASE_DIR/dist/index.html" ]] || fail 'release archive is missing dist/index.html'
ln -sfn "$RELEASE_DIR" "${INSTALL_ROOT}/current"

cat > "${BIN_DIR}/${APP_NAME}" <<EOF
#!/usr/bin/env bash
exec "${NODE_BIN}" "${INSTALL_ROOT}/current/dist-cli/index.js" "\$@"
EOF
chmod 0755 "${BIN_DIR}/${APP_NAME}"

if [[ "$SKIP_SERVICE" != 1 ]]; then
  SYSTEMCTL="$(command -v systemctl || true)"
  if [[ -n "$SYSTEMCTL" ]] && "$SYSTEMCTL" --user is-system-running >/dev/null 2>&1; then
    mkdir -p "$SYSTEMD_DIR"
    cat > "${SYSTEMD_DIR}/${UNIT_NAME}" <<EOF
[Unit]
Description=Codex Remote web interface on port ${PORT}
After=default.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_ROOT}/current
Environment=HOME=${HOME}
Environment=CODEX_HOME=${CODEX_HOME:-${HOME}/.codex}
Environment=PATH=$(dirname "$NODE_BIN"):${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${NODE_BIN} ${INSTALL_ROOT}/current/dist-cli/index.js --no-login --no-tunnel --no-open --port ${PORT} --app-server-socket ${CODEX_HOME:-${HOME}/.codex}/app-server-control/app-server-control.sock
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF
    "$SYSTEMCTL" --user daemon-reload
    "$SYSTEMCTL" --user enable --now "$UNIT_NAME"
    info "service started: $UNIT_NAME"
  else
    info 'user systemd is unavailable; starting Codex Remote in the background'
    nohup "${BIN_DIR}/${APP_NAME}" --no-login --no-tunnel --no-open --port "$PORT" \
      --app-server-socket "${CODEX_HOME:-${HOME}/.codex}/app-server-control/app-server-control.sock" \
      >"${INSTALL_ROOT}/codexapp.log" 2>&1 &
    echo $! >"${INSTALL_ROOT}/codexapp.pid"
  fi
fi

info 'installation complete'
info "web: http://127.0.0.1:${PORT}"
info "LAN: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"
info 'open the web page to complete first-run password setup'
info 'after setup, use Settings -> StarBridge to enter an activation code for public access'
info 'official Codex configuration was not modified'
