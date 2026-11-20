#!/bin/bash
# Builds texpresso-xetex for WASM. Usage: build-engine.sh [node|nodemem|web|kernel]
#   kernel: the engine for the live preview (Asyncify, js/lib-engine.js); ENGINE_ENV=node,worker; ENGINE_FS=-sNODERAWFS=1 for node tests
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH=/opt/wasm/emscripten:$PATH
P=/opt/wasm/sysroot; T=${TP:-/home/claude/tp}/src; O=/opt/wasm/build/engine/obj
export PKG_CONFIG_PATH=$P/lib/pkgconfig PKG_CONFIG_LIBDIR=$P/lib/pkgconfig
PKG="freetype2 harfbuzz harfbuzz-icu graphite2 fontconfig libpng icu-uc zlib"
CF="-O2 -g0 -I$T/engine/include -I$T/engine/layout -I$T/engine/dpx -I$T/include $(pkg-config --cflags $PKG | sed s/-pthread//) ${EXTRA_CFLAGS:-}"
mkdir -p $O
srcs=$(cd $T && ls engine/engine/*.c engine/engine/*.cpp engine/dpx/*.c engine/main/*.c common/*.c engine/layout/*.cpp 2>/dev/null | grep -v _Mac)
compile() { local s=$1; local o=$O/${s//\//_}.o
  [ "$o" -nt "$T/$s" ] && return 0
  case $s in *.cpp) em++ -std=c++17 $CF -c -o $o $T/$s;; *) emcc $CF -c -o $o $T/$s;; esac }
export -f compile; export O T CF PATH
printf "%s\n" $srcs | xargs -P 2 -I{} bash -c "compile {}" ; echo compiled
# link
MODE=${1:-node}
LIBS="$(pkg-config --libs --static $PKG | sed s/-pthread//g)"
OUT=/opt/wasm/build/engine/texpresso-xetex.js
case $MODE in
  web) OUT=/opt/wasm/web/texpresso-xetex.js; LF="-sENVIRONMENT=worker -sMODULARIZE=1 -sEXPORT_NAME=createEngine -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,ENV,callMain";;
  kernel) OUT=/opt/wasm/build/engine/kernel/texpresso-xetex.js; mkdir -p $(dirname $OUT)
    emcc -O2 -c -o $O/engine-keep.o $HERE/js/engine-keep.c
    LF="--js-library $HERE/js/lib-engine.js -sENVIRONMENT=${ENGINE_ENV:-node,worker} -sMODULARIZE=1 -sEXPORT_NAME=createEngine -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,ENV,HEAPU8,callMain -sEXPORTED_FUNCTIONS=_main,_txp_keep_internals,_sbrk -sASYNCIFY=1 -sASYNCIFY_IMPORTS=host_chan_wait,host_fork -sASYNCIFY_STACK_SIZE=1048576 ${ENGINE_FS:-}";;
  nodemem) OUT=/opt/wasm/build/engine/nodemem/texpresso-xetex.js; mkdir -p $(dirname $OUT); LF="-sENVIRONMENT=node -sMODULARIZE=1 -sEXPORT_NAME=createEngine -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,ENV,callMain";;
  node) LF="--pre-js $HERE/pre-node.js -sNODERAWFS=1 -sENVIRONMENT=node -sEXIT_RUNTIME=1";;
esac
em++ -O2 $O/*.o -o $OUT $LIBS -lexpat \
  --js-library $HERE/js/lib-tl.js -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sINITIAL_MEMORY=64MB $LF ${EXTRA_LDFLAGS:-}
# kernel: the engine's abort() (a fatal TeX error: _tt_abort -> abort) must
# end only the engine process, as natively, not stop the WASM module (kernel.js
# treats ExitStatus 134 as the end of that process)
if [ "$MODE" = kernel ]; then
  grep -q 'var __abort_js=()=>abort("");' $OUT || { echo "build-engine.sh: __abort_js not found in $OUT" >&2; exit 1; }
  sed -i 's/var __abort_js=()=>abort("");/var __abort_js=()=>{throw new ExitStatus(134)};/' $OUT
fi
ls -la ${OUT%.js}.*
