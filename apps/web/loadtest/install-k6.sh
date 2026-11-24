#!/usr/bin/env bash
# Downloads the official static k6 release into loadtest/.tools (gitignored),
# verifying it against the release's published SHA-256 checksums file.
# Prints the binary path. Usage: loadtest/install-k6.sh   (K6_VERSION=v2.3.0)
set -euo pipefail

K6_VERSION=${K6_VERSION:-v2.3.0}
TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.tools"
BIN="$TOOLS/k6-$K6_VERSION"

if [[ -x "$BIN" ]]; then
  echo "$BIN"
  exit 0
fi
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "install-k6.sh fetches the linux-amd64 build; install k6 manually on this platform and set K6_BIN." >&2
  exit 1
fi

mkdir -p "$TOOLS"
tmp=$(mktemp -d "$TOOLS/download.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
release="https://github.com/grafana/k6/releases/download/$K6_VERSION"
archive="k6-$K6_VERSION-linux-amd64.tar.gz"
curl -fsSL --retry 3 -o "$tmp/$archive" "$release/$archive"
curl -fsSL --retry 3 -o "$tmp/checksums.txt" "$release/k6-$K6_VERSION-checksums.txt"
expected=$(awk -v file="$archive" '$2 == file { print $1 }' "$tmp/checksums.txt")
actual=$(sha256sum "$tmp/$archive" | awk '{ print $1 }')
if [[ -z "$expected" || "$expected" != "$actual" ]]; then
  echo "k6 checksum mismatch for $archive (expected ${expected:-none}, got $actual)" >&2
  exit 1
fi
echo "k6 $K6_VERSION checksum verified: $actual" >&2
tar -xzf "$tmp/$archive" -C "$tmp"
install -m 0755 "$tmp/k6-$K6_VERSION-linux-amd64/k6" "$BIN"
echo "$BIN"
