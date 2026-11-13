// Emscripten library for texpresso-xetex in WASM: the engine's channel and
// fork go to the kernel (kernel.js), which the host gives as Module.kernel.
addToLibrary({
  host_chan_write: (ptr, len) => Module.kernel.engineWrite(HEAPU8.slice(ptr, ptr + len)),
  host_chan_read: (ptr, len) => Module.kernel.engineRead(HEAPU8, ptr, len),
  host_chan_wait__async: true,
  host_chan_wait__deps: ['$Asyncify'],
  host_chan_wait: () => Asyncify.handleSleep(wakeUp => Module.kernel.engineSuspend('wait', wakeUp, 0)),
  host_fork__async: true,
  host_fork__deps: ['$Asyncify'],
  host_fork: (time) => Asyncify.handleSleep(wakeUp => Module.kernel.engineSuspend('fork', wakeUp, time)),
  // what the kernel needs to take and restore snapshots
  txp_internals__deps: ['$Asyncify', '$stackSave', '$stackRestore'],
  txp_internals__postset: `Module.internals = {
    asyncify: () => Asyncify,
    stackSave: () => stackSave(),
    stackRestore: (sp) => stackRestore(sp),
    memory: () => wasmMemory,
    callMain: (args) => callMain(args),
    updateViews: () => updateMemoryViews(),
  };`,
  txp_internals: () => 0,
});
