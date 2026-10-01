#!/bin/bash
# Hopsworks App entrypoint. The app directory is on HopsFS (FUSE): install and run from local disk.
set -euo pipefail
dir=/tmp/hops-run
rm -rf "$dir" && mkdir -p "$dir"
cp -r package.json package-lock.json server.js config.json public "$dir"/
cd "$dir"
npm ci --omit=dev --no-audit --no-fund
exec node server.js
