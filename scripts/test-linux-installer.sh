#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codexapp-installer-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT

ARCHIVE_DIR="${TEST_DIR}/archive"
mkdir -p "${ARCHIVE_DIR}/dist" "${ARCHIVE_DIR}/dist-cli" "${ARCHIVE_DIR}/bin"
printf '<!doctype html>\n' >"${ARCHIVE_DIR}/dist/index.html"
cat >"${ARCHIVE_DIR}/dist-cli/index.js" <<'EOF'
console.log('installer smoke test')
EOF
cat >"${ARCHIVE_DIR}/bin/codex" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${ARCHIVE_DIR}/bin/codex"
tar -C "$ARCHIVE_DIR" -czf "${TEST_DIR}/codexapp.tar.gz" dist dist-cli

PATH="${ARCHIVE_DIR}/bin:${PATH}" \
CODEXAPP_ARCHIVE="${TEST_DIR}/codexapp.tar.gz" \
CODEXAPP_INSTALL_ROOT="${TEST_DIR}/install" \
CODEXAPP_BIN_DIR="${TEST_DIR}/bin" \
CODEXAPP_SKIP_SERVICE=1 \
  bash "${ROOT_DIR}/install.sh"

[[ -x "${TEST_DIR}/bin/codexapp" ]]
[[ -L "${TEST_DIR}/install/current" ]]
[[ -f "${TEST_DIR}/install/current/dist-cli/index.js" ]]
[[ "$("${TEST_DIR}/bin/codexapp")" == 'installer smoke test' ]]

# Exercise the user-systemd path with a fake systemctl. This verifies that the
# generated unit uses the official socket and does not force --no-password.
SYSTEMD_HOME="${TEST_DIR}/home"
mkdir -p "$SYSTEMD_HOME"
cat >"${ARCHIVE_DIR}/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *'is-system-running'* ]]; then exit 0; fi
exit 0
EOF
chmod +x "${ARCHIVE_DIR}/bin/systemctl"
PATH="${ARCHIVE_DIR}/bin:${PATH}" \
HOME="$SYSTEMD_HOME" \
CODEXAPP_ARCHIVE="${TEST_DIR}/codexapp.tar.gz" \
CODEXAPP_INSTALL_ROOT="${TEST_DIR}/service-install" \
CODEXAPP_BIN_DIR="${TEST_DIR}/service-bin" \
  bash "${ROOT_DIR}/install.sh" >/dev/null
UNIT="${SYSTEMD_HOME}/.config/systemd/user/codexapp-5900.service"
grep -q -- '--app-server-socket' "$UNIT"
if grep -q -- '--no-password' "$UNIT"; then
  echo 'installer incorrectly disabled password protection' >&2
  exit 1
fi
printf 'Linux installer smoke test passed\n'
