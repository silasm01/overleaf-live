// Emscripten library for the TeXpresso driver in WASM: engine processes and
// their channels are in the kernel (kernel.js), given as Module.kernel.
addToLibrary({
  host_spawn: (a0, a1, a2, a3, fdPtr) => {
    const args = [a0, a1, a2, a3].map(p => p ? UTF8ToString(p) : null).filter(a => a !== null);
    const { pid, fd } = Module.kernel.spawn(args);
    HEAP32[fdPtr >> 2] = fd;
    return pid;
  },
  host_kill: (pid) => Module.kernel.kill(pid),
  host_close: (fd) => Module.kernel.close(fd),
  host_drv_read: (fd, ptr, len, passedPtr) => {
    const r = Module.kernel.driverRead(fd, len);
    HEAPU8.set(r.data, ptr);
    if (r.passedFd !== undefined) HEAP32[passedPtr >> 2] = r.passedFd;
    return r.data.length;
  },
  host_drv_write: (fd, ptr, len) => { Module.kernel.driverWrite(fd, HEAPU8.slice(ptr, ptr + len)); return len; },
  host_drv_pending: (fd, timeout) => Module.kernel.driverPending(fd, timeout) ? 1 : 0,
  host_proc_age_ms: () => Module.kernel.age(),
});
