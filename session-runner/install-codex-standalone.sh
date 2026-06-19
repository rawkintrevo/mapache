#!/bin/sh

set -eu

CODEX_VERSION="${CODEX_VERSION:-0.140.0}"
CODEX_TARGET="${CODEX_TARGET:-x86_64-unknown-linux-musl}"
CODEX_SHA256="${CODEX_SHA256:-9620e798900c6fb289199a9e0a8ed0c3a8cb7e3561048498ebc2dac354a1627b}"
CODEX_INSTALL_DIR="${CODEX_INSTALL_DIR:-/usr/local/bin}"
CODEX_RELEASE_ROOT="${CODEX_RELEASE_ROOT:-/opt/codex}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT INT TERM

archive_name="codex-package-${CODEX_TARGET}.tar.gz"
archive_url="https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${archive_name}"
release_dir="${CODEX_RELEASE_ROOT}/${CODEX_VERSION}-${CODEX_TARGET}"

mkdir -p "$CODEX_INSTALL_DIR" "$CODEX_RELEASE_ROOT"
curl -fsSL "$archive_url" -o "$TMP_DIR/codex-package.tar.gz"
printf '%s  %s\n' "$CODEX_SHA256" "$TMP_DIR/codex-package.tar.gz" | sha256sum -c -

rm -rf "$release_dir"
mkdir -p "$release_dir"
tar -xzf "$TMP_DIR/codex-package.tar.gz" -C "$release_dir"
chmod 0755 "$release_dir/bin/codex" "$release_dir/codex-path/rg"
if [ -f "$release_dir/codex-resources/bwrap" ]; then
  chmod 0755 "$release_dir/codex-resources/bwrap"
fi
ln -sfn "$release_dir/bin/codex" "$CODEX_INSTALL_DIR/codex"
