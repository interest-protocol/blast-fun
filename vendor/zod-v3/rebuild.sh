#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
backport_dir=$(mktemp -d)
trap 'rm -rf "$backport_dir"' EXIT
curl --fail --silent --show-error https://registry.npmjs.org/zod/-/zod-3.25.76.tgz -o "$backport_dir/upstream.tgz"
printf '%s  %s\n' 83352dfeab7cd675ec14628815c0b76277c4031e4d92e9c27e70e5bee0524854b4d9b717bb82e679ad001485306cb5b158fc7777da7c4b94286ae8ca70d43171 "$backport_dir/upstream.tgz" | sha512sum --check --status
tar -xzf "$backport_dir/upstream.tgz" -C "$backport_dir"
patch --silent -p1 -d "$backport_dir/package" < security.patch
tar --sort=name --mtime='2026-10-27 00:00:00Z' --owner=0 --group=0 --numeric-owner -cf - -C "$backport_dir" package | gzip -n > blast-zod-v3-3.25.76.tgz
sha256sum blast-zod-v3-3.25.76.tgz
