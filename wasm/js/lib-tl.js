// Emscripten library: TeX Live files for texpresso and texpresso-xetex in WASM.
addToLibrary({
  // TeX Live files (extension/engine/texlive.js, given as Module.tl): no
  // Module.tl (node tests with the real file system): the files are there.
  host_tl_ensure__deps: ['$FS'],
  host_tl_ensure: (p) => (Module.tl ? (Module.tl.ensure(UTF8ToString(p), FS) ? 1 : 0) : 1),
  host_tl_stat: (p, sizePtr, mtimePtr) => {
    const st = Module.tl && Module.tl.stat(p ? UTF8ToString(p) : null);
    if (!st) return 0;
    HEAP32[sizePtr >> 2] = st.size;
    HEAP32[mtimePtr >> 2] = st.mtime;
    return 1;
  },
});
