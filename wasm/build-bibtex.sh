#!/bin/bash
# Builds BibTeX for WASM (extension/engine/bibtex.js + .wasm): Tectonic 0.13.1's
# C BibTeX (wasm/bibtex/bibtex.c, from crates/engine_bibtex) with a stdio I/O
# layer (wasm/bibtex/bibtex-io.c). Usage: build-bibtex.sh [out dir]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH=/opt/wasm/emscripten:$PATH
OUT=${1:-$HERE/../extension/engine}
emcc -O2 -w -I$HERE/bibtex $HERE/bibtex/bibtex.c $HERE/bibtex/bibtex-io.c -o $OUT/bibtex.js \
  -sMODULARIZE=1 -sEXPORT_NAME=createBibtex -sENVIRONMENT=worker,node -sINVOKE_RUN=0 \
  -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain
ls -la $OUT/bibtex.*
