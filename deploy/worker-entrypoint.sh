#!/bin/sh
# Install workspace deps into the mounted checkout (Linux binaries live in /repo/node_modules).
set -e
cd /repo
bun install --frozen-lockfile
mkdir -p worker/.state data/public
exec "$@"
