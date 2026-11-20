#!/bin/sh
# Makes the ZIP for the Chrome Web Store: the extension folder without the
# "key" field (the store gives the ID itself) and without test files.
set -e
cd "$(dirname "$0")"
v=$(python3 -c 'import json;print(json.load(open("extension/manifest.json"))["version"])')
out="overleaf-live-$v.zip"
tmp=$(mktemp -d)
cp -r extension "$tmp/ext"
python3 - "$tmp/ext/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m.pop("key", None)
# not "Overleaf Live": the store does not allow names that look like another company's product
m["name"] = "Live Preview for Overleaf (TeXpresso)"
m["description"] = "Live LaTeX preview for Overleaf, typeset by TeXpresso in your browser. Not affiliated with Overleaf."
json.dump(m, open(p, "w"), indent=2, ensure_ascii=False)
PY
rm -f "$out"
(cd "$tmp/ext" && zip -qr -9 -X "$OLDPWD/$out" . -x '*.DS_Store' '*~')
rm -rf "$tmp"
echo "$out"
