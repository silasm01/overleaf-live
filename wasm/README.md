# TeXpresso in WASM (phases 1 to 3)

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

## Phase 2: live preview with snapshots (14 Nov 2026)

The TeXpresso driver (`src/frontend`, `src/dvi`, MuPDF 1.23.10) and the engine
run as two WASM modules in one worker. `js/kernel.js` connects them.

- `build-driver.sh`: builds the driver (`texpresso.js` / `.wasm`, 4.7 MB with
  MuPDF). It needs MuPDF built with `make OS=wasm ... libs` and the SDL2
  sources for the Emscripten port (`EMCC_LOCAL_PORTS=sdl2=<SDL release-2.32.8>`).
  SDL is only compiled in; the WASM build does not use it.
- `build-engine.sh kernel`: the engine with Asyncify (4.4 MB).
- `js/lib-engine.js`, `js/lib-driver.js`: the host functions of the two modules.
- `js/kernel.js`: in place of processes and sockets.
  - The driver is the main program. When it reads an engine channel and no
    data is there, the kernel runs the engine until the engine sends a query.
  - The engine is a coroutine (Asyncify). `fork` takes a snapshot of the
    engine memory; the child continues. If the driver rolls back, the kernel
    restores the parent's snapshot and `host_fork` returns the child's id.
  - Snapshots are lists of 64 KiB pages in a page store (a second WASM
    memory). `js/pagestore.wat` compares and copies pages with SIMD
    (multi-memory). Snapshots share unchanged pages.
- The driver's API (end of `src/frontend/main.c`): `txp_wasm_init`,
  `txp_wasm_input` (the same commands as on stdin), `txp_wasm_tick`,
  `txp_wasm_idle`. The output is the same as on stdout (`page-image`, ...).
- Snapshot policy: the driver asks for a fork after `TXP_SNAP_MS` (250) ms of
  engine time, not after 500 TeX tokens as natively: a WASM snapshot is not free.
- Reruns for `.aux` are off, as natively.

### Results (Chrome 153 headless worker, 2-core VM; latex-templates main.tex, export of pages 1-3)

| Step | Native TeXpresso | WASM in Chrome |
|---|---|---|
| Start to first page | 2.06-2.37 s | 2.37-2.50 s |
| Edit 1 (page 3) | 0.12-0.15 s | 0.33 s |
| Edit 2 (page 3) | 0.10-0.12 s | 0.13 s |

- Pages after the two edits: identical to native TeXpresso (`test/native-timed.py`).
- 9 forks, 2 restores; snapshots 0.5 s in total; engine memory 349 MiB.
- Tests: `test/worker-live.js` + `test/live.html` + `test/run-chrome-live.mjs`
  (Chrome), `test/node-live.cjs` (Node, NODERAWFS builds).

### Still to do
- One file system for both modules in the browser (now each module gets a copy of the files).
- Pixels to the viewer in place of PNG files.
- `ASYNCIFY_ONLY` (smaller and faster engine), a faster restore.
- If the engine aborts, make a new engine instance.
- Send command text without `\uXXXX` escapes (as the helper's `sexp_string`); TeXpresso does not read them.

## Phase 3: in the extension (14 Nov 2026)

- `extension/engine/`: `offscreen.html` + `offscreen.js` (an offscreen
  document, reason WORKERS) start `worker.js`, a JavaScript copy of the
  helper's project logic (`helper/overleaf_live.py`) with the WASM TeXpresso.
  The messages are the same as the helper's WebSocket messages.
- `background.js` connects each tab either to the offscreen document
  (`engine: browser`, default) or to the WSL helper (`engine: wsl`).
- The XeLaTeX format is built on the first start and kept in the Origin
  Private File System of the extension.
- Built files in `extension/engine/`: copy them after a build
  (`build-engine.sh kernel` with `ENGINE_ENV=worker`, `build-driver.sh` with
  `DRIVER_ENV=worker OUT=../extension/engine/texpresso.js`, `js/kernel.js`).
- `tex/bundle.json` + `tex/bundle.bin`: the TeX Live 2023 files that native
  TeXpresso reads for the latex-templates template (strace), 448 files,
  15.4 MiB. Phase 4 replaces it with downloads on demand.
- Fewer fences: `TXP_MAX_FENCES` (default 4; natively 16), because each
  fence is a snapshot.

### Results (headless Chrome 153, the extension loaded, 2-core VM)

| Step | Native TeXpresso | Extension, first start | Extension, later start |
|---|---|---|---|
| First page | 2.1-2.4 s | 9.5 s (format build) | 2.7 s |
| Edit 1 (page 3) | 0.12-0.15 s | 0.49 s | 0.40 s |
| Edit 2 (page 3) | 0.10-0.12 s | 0.18 s | 0.15 s |

Pages 1-3 after the two edits: identical to native TeXpresso.
