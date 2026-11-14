#!/bin/bash
# Builds the TeXpresso driver (src/frontend + src/dvi) for WASM.
# Needs MuPDF 1.23 built with OS=wasm in $MUPDF (see README.md).
# Usage: build-driver.sh   (env DRIVER_ENV=node,worker, DRIVER_FS=-sNODERAWFS=1 for node tests)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH=/opt/wasm/emscripten:$PATH
T=${TP:-/home/claude/tp}/src; MUPDF=${MUPDF:-/opt/wasm/src/mupdf}; LUA=${LUA:-/opt/wasm/src/lua54}; O=/opt/wasm/build/driver/obj
OUT=${OUT:-/opt/wasm/build/driver/texpresso.js}
mkdir -p $O $(dirname $OUT)
CF="-O2 -sUSE_SDL=2 -I$T/dvi -I$T/include -I$T/frontend -I$LUA -I$MUPDF/include -I$MUPDF/thirdparty/freetype/include ${EXTRA_CFLAGS:-}"
srcs="frontend/main.c frontend/sprotocol.c frontend/state.c frontend/fs.c frontend/incdvi.c frontend/myabort.c
 frontend/renderer.c frontend/engine_tex.c frontend/engine_pdf.c frontend/engine_dvi.c frontend/synctex.c
 frontend/prot_parser.c frontend/sexp_parser.c frontend/json_parser.c frontend/editor.c frontend/logo.c
 dvi/dvi_context.c dvi/dvi_interp.c dvi/dvi_prim.c dvi/dvi_special.c dvi/dvi_scratch.c dvi/dvi_fonttable.c
 dvi/dvi_resmanager.c dvi/tex_tfm.c dvi/tex_fontmap.c dvi/tex_vf.c dvi/tex_enc.c dvi/vstack.c dvi/pdf_lexer.c
 common/utils.c common/texlive_provider.c common/tectonic_provider.c frontend/txp_lua.c"
compile() { local s=$1; local o=$O/${s//\//_}.o
  [ "$o" -nt "$T/$s" ] && return 0
  emcc $CF -c -o $o $T/$s; }
export -f compile; export O T CF PATH
printf "%s\n" $srcs | xargs -P 2 -I{} bash -c "compile {}"
# Lua 5.4 (git clone --branch v5.4.7 https://github.com/lua/lua) for piped input (frontend/txp_lua.c)
for f in $LUA/l*.c; do
  case $(basename $f) in lua.c|luac.c|ltests.c) continue;; esac
  o=$O/lua_$(basename $f .c).o
  [ "$o" -nt "$f" ] || emcc -O2 -c -o $o $f
done
emcc -O2 $O/*.o -o $OUT $MUPDF/build/wasm/release/libmupdf.a $MUPDF/build/wasm/release/libmupdf-third.a \
  --js-library $HERE/js/lib-driver.js --js-library $HERE/js/lib-tl.js -sUSE_SDL=2 \
  -sENVIRONMENT=${DRIVER_ENV:-node,worker} -sMODULARIZE=1 -sEXPORT_NAME=createDriver -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS=_txp_wasm_init,_txp_wasm_input,_txp_wasm_tick,_txp_wasm_idle,_txp_wasm_debug,_txp_wasm_run_to_end,_txp_wasm_status,_txp_wasm_dump_outputs,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=FS,ENV,HEAPU8,stringToUTF8,lengthBytesUTF8,UTF8ToString,ccall \
  ${DRIVER_FS:-} ${EXTRA_LDFLAGS:-}
ls -la ${OUT%.js}.*
