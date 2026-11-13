#!/bin/bash
# update.sh -- gets the newest Overleaf Live from GitHub and installs it.
#   ~/overleaf-live-src/update.sh
set -euo pipefail
cd "$(dirname "$0")"
before="$(git rev-parse HEAD)"
git pull --ff-only -q
after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ] && [ "${1:-}" != "--force" ]; then
  echo "Already the newest version ($(git log -1 --format='%h %s'))."
  echo "To install again anyway: $0 --force"
  exit 0
fi
echo "Changes:"
git log --format='  %h %s' "$before..$after" 2>/dev/null || true
exec bash ./install.sh --update
