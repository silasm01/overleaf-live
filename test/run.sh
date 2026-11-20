#!/bin/bash
# run.sh -- the tests of Overleaf Live (browser engine). See test/README.md.
#   test/run.sh [suite ...] [--templates <latex-templates folder>] [--replay <report.json>]
# Needs: node, Google Chrome, playwright (npm -g), python3 and a TeX Live
# (for the test TeX Live repository, made once from the local TeX Live).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="${OLIVE_TEST_CACHE:-$HOME/.cache/olive-test}"
export TLNET="${TLNET:-$CACHE/tlnet}"
export TEST_PROFILE="${TEST_PROFILE:-$CACHE/chrome-profile}"
export PLAYWRIGHT="${PLAYWRIGHT:-$(npm root -g)/playwright/index.mjs}"
if [ ! -f "$TLNET/tlpkg/texlive.tlpdb.xz" ]; then
  echo "making the test TeX Live repository in $TLNET (one time, approx. 1 minute)"
  mkdir -p "$TLNET"
  python3 -I "$HERE/../wasm/test/make-fake-tlnet.py" "$TLNET"
fi
mkdir -p "$TEST_PROFILE"
exec node "$HERE/run.mjs" "$@"
