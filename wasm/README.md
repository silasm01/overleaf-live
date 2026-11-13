# TeXpresso in WASM (phase 1)

This folder builds the TeXpresso engine (`texpresso-xetex`) for WebAssembly.
Phase 1 shows that the engine runs in a Chrome Web Worker and gives the same
pages as native XeLaTeX. The extension does not use it yet.

## Files

- `build-deps.sh`: builds the libraries for WASM into `/opt/wasm/sysroot`
  (zlib, libpng, freetype, graphite2, expat, fontconfig, harfbuzz). ICU comes
  from the Emscripten port (stub data: no locale line breaking yet).
- `build-engine.sh [node|nodemem|web]`: builds the engine.
  - `node`: runs with `node`, uses the real file system (for tests).
  - `web`: a module for a Web Worker (`createEngine()`), with an in-memory
    file system.
- `texpresso-wasm.patch`: changes to TeXpresso for WASM. Apply it after
  `../texpresso/png-export.patch`.
  - `TEXPRESSO_LSR` names a file that lists the `ls-R` files (WASM cannot
    start `kpsewhich`).
  - no `execinfo.h`, no `linux/limits.h` in WASM.
  - `ttstub_input_seek` returns the new position, as Tectonic expects. Before,
    it returned the result of `fseek` (0). This error stopped PDF pictures
    (for example `example-image-a.pdf`) when the engine read files itself.
- `test/`: Chrome test. `make-bundle.py` packs the files that a compile reads;
  `worker.js` runs three passes; `run-chrome.mjs` starts headless Chrome.

## Tools

Emscripten 4.0.23, LLVM 22.1.4, Binaryen 125 (all from GitHub; emsdk's own
download server is not available in the cloud workspace).

## Results (13 Nov 2026, cloud VM with 2 cores, Chrome 153 headless)

latex-templates `main.tex`, 22 pages, XeLaTeX, no shell escape:

| Run | Time |
|---|---|
| Native `xelatex` (TeX Live 2023), one pass | 3.2 s |
| Native `texpresso-xetex`, one pass | 3.0 s |
| WASM in a Chrome worker, format build + first pass | 9.1 s |
| WASM in a Chrome worker, one pass with the format | 3.5–3.6 s |

- Pages 1–21 are the same as native XeLaTeX. Page 1 has a different date only
  because the test sets `SOURCE_DATE_EPOCH`. Page 22 is the compile-time table
  of the profile module.
- The compile reads only 443 TeX Live files (15.7 MB), format build included.
- `texpresso-xetex.wasm`: 3.2 MB (1.2 MB with gzip).

## Things to know

- The format check compares the size and the modification time of each file.
  Give files a fixed modification time in the in-memory file system, or the
  engine builds the format again on each run (+5 s).
- Files in `TEXINPUTS` folders (`template//`) are not found in standalone
  mode. The test links them into the project folder. In TeXpresso mode the
  driver finds them (`-I`).
