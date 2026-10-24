#!/usr/bin/env bash
# Render a UI fixture with headless Chrome at several widths, so CSS changes can be checked by eye
# (jsdom runs the tests but cannot lay anything out).
#
#   scripts/render-check.sh                       # every fixture in scripts/render/, widths 1250 1000 720 390 (below 500px: in an iframe)
#   scripts/render-check.sh usage-strip 1250 412         # one fixture, your widths
#
# RENDER_HEIGHT sets the window height (default 160) for taller fixtures.
# PNGs land in ${RENDER_OUT:-/tmp/deck-render}/<fixture>-<width>.png (2x scale). Read them with an image viewer
# or the Read tool. Fixtures link the real stylesheet relatively, so they render whatever is in the working tree.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${RENDER_OUT:-/tmp/deck-render}"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || chrome="$(command -v google-chrome || command -v chromium || true)"
[ -n "$chrome" ] && [ -x "$chrome" ] || { echo "Chrome not found (set CHROME=/path/to/chrome)" >&2; exit 1; }

fixture="${1:-}"
if [ $# -gt 0 ]; then shift; fi
widths=("$@")
[ ${#widths[@]} -gt 0 ] || widths=(1250 1000 720 390)
if [ -n "$fixture" ]; then files=("$here/render/$fixture.html"); else files=("$here"/render/*.html); fi

mkdir -p "$out"
profile="$(mktemp -d)"
trap 'rm -rf "$profile"' EXIT
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "no fixture: $f" >&2; exit 1; }
  name="$(basename "$f" .html)"
  for w in "${widths[@]}"; do
    png="$out/$name-$w.png"
    url="file://$f"; win="$w"
    # Headless Chrome will not make a window narrower than 500px: a phone width renders the fixture in an iframe of that
    # width instead (its media queries and the data-phone check see the iframe's width), on a 500px window.
    if [ "$w" -lt 500 ]; then
      wrap="$profile/wrap-$name-$w.html"
      printf '<!doctype html><body style="margin:0;background:#777"><iframe src="file://%s" style="display:block;width:%spx;height:%spx;border:0"></iframe>' \
        "$f" "$w" "${RENDER_HEIGHT:-160}" >"$wrap"
      url="file://$wrap"; win=500
    fi
    "$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$profile" \
      --force-device-scale-factor=2 --window-size="$win,${RENDER_HEIGHT:-160}" --screenshot="$png" "$url" >/dev/null 2>&1
    echo "$png"
  done
done
