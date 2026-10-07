#!/bin/bash
# Hopsworks App entrypoint for the designer. The app directory is on HopsFS (FUSE) and holds the
# repo's pieces the designer runs on (designer/, arena/, game/public/sim.js, pilot/deciders.js,
# bots/): they are copied to local disk, three.js (the simulation's maths) installed next to them.
set -euo pipefail
dir=/tmp/hops-run-designer
rm -rf "$dir" && mkdir -p "$dir"
cp -r ../designer ../arena ../game ../pilot ../bots "$dir"/
cp package.json package-lock.json config.json "$dir"/
cd "$dir"
export npm_config_cache="$dir/npm"
npm ci --no-audit --no-fund

# The pilot token lives in a Hopsworks secret of the App's owner.
setting() { python -c 'import json, sys; print(json.load(open("config.json")).get(sys.argv[1]) or "")' "$1"; }
PILOT_TOKEN=$(python -c 'import sys, hopsworks; hopsworks.login(); print(hopsworks.get_secrets_api().get_secret(sys.argv[1]).value)' "$(setting tokenSecret)" | tail -n 1)
export PILOT_TOKEN
exec node designer/designer.js
