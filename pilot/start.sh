#!/bin/bash
# Hopsworks App entrypoint for the jevworks pilot. The app directory is on HopsFS (FUSE): install
# and run from local disk. The App image lacks a few libraries Chromium needs and the pod has no
# root, so their Ubuntu packages are downloaded with a user-owned apt state and unpacked locally.
set -euo pipefail
dir=/tmp/jevworks-pilot
rm -rf "$dir" && mkdir -p "$dir/debs" "$dir/libs" "$dir/apt/lists/partial" "$dir/apt/cache/archives/partial"
cp package.json package-lock.json runner.js config.json "$dir"/
cd "$dir"

export PLAYWRIGHT_BROWSERS_PATH="$dir/browsers" npm_config_cache="$dir/npm"
npm ci --no-audit --no-fund
npx playwright install --only-shell chromium

apt=(-o "Dir::State::Lists=$dir/apt/lists" -o "Dir::Cache=$dir/apt/cache" -o Debug::NoLocking=1 -o "APT::Sandbox::User=$(id -un)")
apt-get "${apt[@]}" update -qq
(cd debs && apt-get "${apt[@]}" download libatk-bridge2.0-0t64 libatspi2.0-0t64 libxkbcommon0 libxres1)
for deb in debs/*.deb; do dpkg-deb -x "$deb" libs; done
export LD_LIBRARY_PATH="$dir/libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# The token the game accepts pilot runs with lives in a Hopsworks secret of the App's owner.
secret=$(python -c 'import json; print(json.load(open("config.json"))["tokenSecret"])')
PILOT_TOKEN=$(python -c 'import sys, hopsworks; hopsworks.login(); print(hopsworks.get_secrets_api().get_secret(sys.argv[1]).value)' "$secret" | tail -n 1)
export PILOT_TOKEN
exec node runner.js
