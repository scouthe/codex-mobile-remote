#!/usr/bin/env bash
set -Eeuo pipefail

# Build a release archive consumed by install.sh. This runs in CI or by a
# maintainer and does not alter the working tree's tracked files.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${1:-${ROOT_DIR}/release}"
VERSION="${CODEXAPP_VERSION:-$(node -p "require('${ROOT_DIR}/package.json').version")}"

cd "$ROOT_DIR"
command -v pnpm >/dev/null 2>&1 || { echo 'pnpm is required' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo 'tar is required' >&2; exit 1; }

pnpm install --frozen-lockfile
pnpm run build

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codexapp-release.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
APP_DIR="${WORK_DIR}/app"
mkdir -p "$APP_DIR"

# Install only runtime dependencies into the staging tree. The source checkout
# is never pruned, and node_modules in the resulting archive is self-contained.
cp package.json pnpm-lock.yaml "$APP_DIR/"
mkdir -p "$APP_DIR/scripts"
cp scripts/fix-pty-native-build.cjs "$APP_DIR/scripts/"
(cd "$APP_DIR" && pnpm install --prod --frozen-lockfile)
cp -a dist dist-cli "$APP_DIR/"
mkdir -p "$OUTPUT_DIR"

case "$(uname -m)" in
  x86_64|amd64) RELEASE_ARCH='amd64' ;;
  aarch64|arm64) RELEASE_ARCH='arm64' ;;
  *) echo "unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

ARCHIVE="${OUTPUT_DIR}/codexapp-linux-${RELEASE_ARCH}.tar.gz"
tar -C "$APP_DIR" -czf "$ARCHIVE" dist dist-cli node_modules package.json
(cd "$OUTPUT_DIR" && sha256sum "$(basename "$ARCHIVE")" > SHA256SUMS)
echo "created ${ARCHIVE} (version ${VERSION})"
