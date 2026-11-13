#!/bin/bash
# install.sh -- sets up the Overleaf Live helper in WSL (Ubuntu 24.04).
# Run it from this folder:   bash install.sh
# It installs: build tools and libraries (apt, only the missing ones),
# TeX Live 2026 in ~/texlive (if it isn't there), TeXpresso with the PNG
# export patch in ~/texpresso (rebuilt only when the patch changed), the
# helper in ~/overleaf-live, and the extension in your Windows folder
# (C:\Users\<you>\overleaf-live-extension). update.sh runs it after git pull.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TEXPRESSO_COMMIT=e8df770     # the version the patch was made and tested on
TL_DIR="$HOME/texlive"

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

step "1/5 Packages from Ubuntu"
PACKAGES="build-essential git wget perl fontconfig cargo unzip \
  libsdl2-dev libmupdf-dev libmujs-dev libfreetype-dev libgumbo-dev \
  libjbig2dec0-dev libjpeg-dev libopenjp2-7-dev libssl-dev libfontconfig-dev \
  libleptonica-dev libharfbuzz-dev python3 python3-websockets"
missing=""
for p in $PACKAGES; do dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then
  echo "installing:$missing (asks for your WSL password)"
  sudo apt-get update -q
  sudo apt-get install -y -q $missing
else
  echo "all there"
fi

step "2/5 TeX Live 2026 in $TL_DIR (approx. 2-3 GB, can take 20-40 minutes)"
if [ -x "$TL_DIR/bin/x86_64-linux/xelatex" ]; then
  echo "already installed"
else
  tmp="$(mktemp -d)"
  wget -q -O "$tmp/install-tl.tar.gz" https://mirror.ctan.org/systems/texlive/tlnet/install-tl-unx.tar.gz
  tar -xzf "$tmp/install-tl.tar.gz" -C "$tmp"
  cat > "$tmp/texlive.profile" <<EOF
selected_scheme scheme-basic
TEXDIR $TL_DIR
TEXMFLOCAL $TL_DIR/texmf-local
TEXMFSYSCONFIG $TL_DIR/texmf-config
TEXMFSYSVAR $TL_DIR/texmf-var
TEXMFHOME ~/texmf
binary_x86_64-linux 1
collection-latexextra 1
collection-pictures 1
collection-mathscience 1
collection-langeuropean 1
collection-langenglish 1
collection-xetex 1
collection-luatex 1
collection-fontsrecommended 1
collection-binextra 1
instopt_adjustpath 0
tlpdbopt_autobackup 0
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
EOF
  perl "$tmp"/install-tl-*/install-tl --profile="$tmp/texlive.profile"
  rm -rf "$tmp"
fi
export PATH="$TL_DIR/bin/x86_64-linux:$PATH"
xelatex --version | head -1

step "3/5 TeXpresso with the PNG export patch in ~/texpresso"
PATCH_ID="$(sha256sum "$HERE/texpresso/png-export.patch" | cut -c1-16)"
REBUILT=0
if [ -x "$HOME/texpresso/build/texpresso" ] &&
   [ "$(cat "$HOME/texpresso/.overleaf-live-patch" 2>/dev/null)" = "$PATCH_ID" ]; then
  echo "already built with this patch"
else
  if [ ! -d "$HOME/texpresso/.git" ]; then
    git clone https://github.com/let-def/texpresso.git "$HOME/texpresso"
  fi
  cd "$HOME/texpresso"
  git am --abort 2>/dev/null || true
  git checkout -q -f "$TEXPRESSO_COMMIT"
  git -c user.name=overleaf-live -c user.email=none am -q "$HERE/texpresso/png-export.patch"
  make config >/dev/null
  # a clean build: make doesn't rebuild what depends on a changed header
  make clean >/dev/null
  make all
  echo "$PATCH_ID" > "$HOME/texpresso/.overleaf-live-patch"
  REBUILT=1
  cd "$HERE"
fi

step "4/5 Helper in ~/overleaf-live, extension in Windows"
mkdir -p "$HOME/overleaf-live"
cp "$HERE/helper/overleaf_live.py" "$HOME/overleaf-live/"
cat > "$HOME/overleaf-live/start.sh" <<START
#!/bin/bash
# Runs the Overleaf Live helper (Windows starts this at logon), and starts
# it again when it stops: update.sh stops it to load the new version.
export PATH="$TL_DIR/bin/x86_64-linux:\$PATH"
export TEXPRESSO="$HOME/texpresso/build/texpresso"
while true; do
  python3 "$HOME/overleaf-live/overleaf_live.py" >> "$HOME/overleaf-live/helper.log" 2>&1
  sleep 1
done
START
chmod +x "$HOME/overleaf-live/start.sh"

# the extension's version: the helper tells the extension, which then
# reloads itself from the folder below when it is older
python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" \
  "$HERE/extension/manifest.json" > "$HOME/overleaf-live/extension-version"

WINHOME=""
if command -v cmd.exe >/dev/null 2>&1; then
  WINHOME="$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')" 2>/dev/null || true)"
fi
if [ -n "$WINHOME" ] && [ -d "$WINHOME" ]; then
  rm -rf "$WINHOME/overleaf-live-extension"
  cp -r "$HERE/extension" "$WINHOME/overleaf-live-extension"
  echo "extension: $(wslpath -w "$WINHOME/overleaf-live-extension")"
else
  echo "not in WSL: extension not copied to Windows"
fi

# (re)start the helper: a running start.sh loop starts the new version
if pgrep -f "overleaf-live/start.sh" >/dev/null; then
  pkill -f overleaf_live.py || true
  echo "helper restarted"
else
  pkill -f overleaf_live.py || true
  setsid nohup "$HOME/overleaf-live/start.sh" >/dev/null 2>&1 < /dev/null &
  echo "helper started (it stops when WSL stops; the scheduled task starts it at logon)"
fi

step "5/5 Test: TeXpresso renders a page"
if [ "$REBUILT" = 0 ] && [ "${1:-}" = "--update" ]; then
  echo "skipped (TeXpresso not rebuilt)"
else
test_dir="$(mktemp -d)"
printf '\\documentclass{article}\\begin{document}Hello from TeXpresso\\end{document}\n' > "$test_dir/main.tex"
mkfifo "$test_dir/in"
SDL_VIDEODRIVER=offscreen "$HOME/texpresso/build/texpresso" -texlive "$test_dir/main.tex" \
  < "$test_dir/in" > "$test_dir/out" 2>/dev/null &
pid=$!
exec 3> "$test_dir/in"
echo "(export-png \"$test_dir\" 400)" >&3
ok=0
for i in $(seq 1 120); do          # the first run builds formats: up to 2 minutes
  if grep -q page-image "$test_dir/out"; then ok=1; break; fi
  sleep 1
done
exec 3>&-
kill $pid 2>/dev/null || true
if [ $ok = 1 ]; then echo "OK: TeXpresso works"; else echo "FAILED: TeXpresso made no page"; fi
rm -rf "$test_dir"
fi

echo
echo "Done. The helper's log is ~/overleaf-live/helper.log"
