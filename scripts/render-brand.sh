#!/usr/bin/env bash
# Render the AI-MSG logo comparison sheet (docs/brand/logo-options.html) to docs/brand/logo-options.png with headless
# Chrome, the same way scripts/render-check.sh renders the UI fixtures.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || chrome="$(command -v google-chrome || command -v chromium || true)"
[ -n "$chrome" ] && [ -x "$chrome" ] || { echo "Chrome not found (set CHROME=/path/to/chrome)" >&2; exit 1; }
profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT
"$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$profile" \
  --force-device-scale-factor=2 --window-size=1440,1010 --screenshot="$root/docs/brand/logo-options.png" \
  "file://$root/docs/brand/logo-options.html" >/dev/null 2>&1
echo "$root/docs/brand/logo-options.png"
