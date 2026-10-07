#!/bin/bash
# Hopsworks App entrypoint for the model pilots. The app directory is on HopsFS (FUSE): install
# and run from local disk. The App image lacks a few libraries Chromium needs, and the loaders it
# opens to reach the GPU driver (Vulkan, EGL); the pod has no root, so their Ubuntu packages are
# downloaded with a user-owned apt state and unpacked locally.
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
(cd debs && apt-get "${apt[@]}" download libatk-bridge2.0-0t64 libatspi2.0-0t64 libxkbcommon0 libxres1 libvulkan1 libegl1 libglvnd0 libgles2)
for deb in debs/*.deb; do dpkg-deb -x "$deb" libs; done
export LD_LIBRARY_PATH="$dir/libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# The pilot token, the stream key and the TypeSafe key live in Hopsworks secrets of the App's owner.
setting() { python -c 'import json, sys; print(json.load(open("config.json")).get(sys.argv[1]) or "")' "$1"; }
secret() { python -c 'import sys, hopsworks; hopsworks.login(); print(hopsworks.get_secrets_api().get_secret(sys.argv[1]).value)' "$1" | tail -n 1; }
PILOT_TOKEN=$(secret "$(setting tokenSecret)")
export PILOT_TOKEN
typesafe_secret=$(setting typesafeSecret)
if [ -n "$typesafe_secret" ]; then
  TYPESAFE_API_KEY=$(secret "$typesafe_secret")
  export TYPESAFE_API_KEY
fi
stream_secret=$(setting streamSecret)
if [ -n "$stream_secret" ]; then
  # Static ffmpeg with NVENC, on the 8.1 release branch (BtbN keeps this name, dated builds expire).
  curl -fsSL https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz | tar xJ
  export FFMPEG="$dir/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg"
  STREAM_KEY=$(secret "$stream_secret")
  export STREAM_KEY
fi
exec node runner.js
