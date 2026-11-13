// kernel.js: runs the TeXpresso driver and the TeXpresso engine (both WASM)
// in one JavaScript thread, in place of the processes and sockets of the
// native version.
//
// - The driver is the main program. When it reads from an engine channel
//   and no data is there, the kernel runs the engine until the engine writes
//   data or waits for an answer.
// - The engine is a coroutine (Asyncify). It suspends in host_chan_wait (it
//   waits for an answer) and in host_fork.
// - fork: the kernel takes a snapshot of the engine's linear memory (and the
//   Asyncify stack, which is in that memory). The child continues at once.
//   The parent continues only if the driver rolls back to it: then the kernel
//   restores the snapshot and host_fork returns the child's id.
// - Snapshots share the 64 KiB pages that did not change since the last
//   snapshot.

'use strict';

const PAGE = 65536;
// js/pagestore.wat, assembled (wasm-as --enable-simd --enable-multimemory --enable-bulk-memory)
const PAGESTORE_WASM = 'AGFzbQEAAAABEQNgAn9/AGACf38Bf2ABfwF/AgwBA2VudgNlbmcCAAEDBQQBAgAABQMBAAEHIwUFc3RvcmUCAQJlcQAABHplcm8AAQRzYXZlAAIEbG9hZAADCv0BBIEBAQN/IABBEHQhAiABQRB0IQMgAkGAgARqIQQDQCAC/QAEACAD/QBEAQD9USAC/QAEECAD/QBEARD9Uf1QIAL9AAQgIAP9AEQBIP1RIAL9AAQwIAP9AEQBMP1R/VD9UP1TBEBBAA8LIAJBwABqIQIgA0HAAGohAyACIARJDQALQQELTgECfyAAQRB0IQEgAUGAgARqIQIDQCAB/QAEACAB/QAEEP1QIAH9AAQgIAH9AAQw/VD9UP1TBEBBAA8LIAFBwABqIQEgASACSQ0AC0EBCxQAIAFBEHQgAEEQdEGAgAT8CgEACxQAIAFBEHQgAEEQdEGAgAT8CgABCw==';

class ByteQueue {
  constructor() { this.chunks = []; this.length = 0; this.consumed = 0; }
  push(bytes) { if (bytes.length) { this.chunks.push(bytes); this.length += bytes.length; } }
  read(max) {
    const n = Math.min(max, this.length);
    const out = new Uint8Array(n);
    let pos = 0;
    while (pos < n) {
      const c = this.chunks[0];
      const take = Math.min(c.length, n - pos);
      out.set(take === c.length ? c : c.subarray(0, take), pos);
      pos += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.length -= n;
    this.consumed += n;
    return out;
  }
  clear() { this.consumed += this.length; this.chunks = []; this.length = 0; }
}

class Channel {
  constructor(fd) {
    this.fd = fd;
    this.toDriver = new ByteQueue();  // queries from the engine
    this.toEngine = new ByteQueue();  // answers from the driver
    this.passed = [];                 // [{offset, fd}]: fds sent with CHLD
    this.closed = false;              // the driver closed its end
    this.eof = false;                 // the engine ended
  }
}

class Kernel {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.channels = new Map();   // driver fd -> Channel
    this.procs = new Map();      // pid -> process
    this.nextFd = 100;
    this.nextPid = 1000;
    this.resident = null;        // the process whose state is in the engine memory
    this.current = null;         // the channel of the running engine
    this.suspension = null;
    this.lastSnap = null;        // base for page sharing
    this.stats = { forks: 0, restores: 0, snapMs: 0, restoreMs: 0, pagesCopied: 0, runMs: 0 };
  }

  // Call once, with the engine module (after its runtime is ready).
  attachEngine(engine) {
    this.engine = engine;
    this.I = engine.internals;
    this.initStore();
    this.pristine = this.takeSnapshot();   // the state before main(); kept
  }

  // ---- memory snapshots -------------------------------------------------
  // A snapshot is a list of slots in the page store (one per 64 KiB page of
  // the engine memory). Slot 0 is a page of zeros. Snapshots share the slots
  // of pages that did not change (reference counts).
  memory() { return new Uint8Array(this.I.memory().buffer); }

  initStore() {
    const bytes = typeof Buffer !== 'undefined' ? Buffer.from(PAGESTORE_WASM, 'base64')
      : Uint8Array.from(atob(PAGESTORE_WASM), c => c.charCodeAt(0));
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { eng: this.I.memory() } });
    this.ps = inst.exports;
    this.storeSlots = this.ps.store.buffer.byteLength / PAGE;   // slot 0: zeros
    this.nextSlot = 1;
    this.freeSlots = [];
    this.refs = new Int32Array(1024);
  }

  allocSlot() {
    if (this.freeSlots.length) return this.freeSlots.pop();
    const s = this.nextSlot++;
    if (s >= this.storeSlots) {
      const add = Math.max(256, this.storeSlots >> 2);
      this.ps.store.grow(add);
      this.storeSlots += add;
    }
    if (s >= this.refs.length) { const r = new Int32Array(this.refs.length * 2); r.set(this.refs); this.refs = r; }
    return s;
  }

  retain(snap) { for (const s of snap.pages) if (s) this.refs[s]++; }
  release(snap) {
    if (!snap) return;
    for (const s of snap.pages) if (s && --this.refs[s] === 0) this.freeSlots.push(s);
  }

  takeSnapshot() {
    const t0 = performance.now();
    const ps = this.ps;
    const count = this.I.memory().buffer.byteLength / PAGE;
    const base = this.lastSnap ? this.lastSnap.pages : null;
    const pages = new Int32Array(count);
    let copied = 0;
    for (let i = 0; i < count; i++) {
      const b = base && i < base.length ? base[i] : -1;
      if (b >= 0 && ps.eq(i, b)) { pages[i] = b; continue; }
      if (ps.zero(i)) { pages[i] = 0; continue; }
      const s = this.allocSlot();
      ps.save(i, s);
      pages[i] = s;
      copied++;
    }
    const A = this.I.asyncify();
    const snap = { pages, sp: this.I.stackSave(), currData: A.currData };
    this.retain(snap);                    // the owner's reference
    this.retain(snap);                    // the reference as diff base
    this.release(this.lastSnap);
    this.lastSnap = snap;
    this.stats.snapMs += performance.now() - t0;
    this.stats.pagesCopied += copied;
    return snap;
  }

  restoreSnapshot(snap) {
    const t0 = performance.now();
    const ps = this.ps;
    const need = snap.pages.length;
    let have = this.I.memory().buffer.byteLength / PAGE;
    if (have < need) {                    // the memory is smaller: grow it
      this.I.memory().grow(need - have);
      this.I.updateViews();
      have = need;
    }
    for (let i = 0; i < need; i++)
      if (!ps.eq(i, snap.pages[i])) ps.load(snap.pages[i], i);
    if (have > need) this.memory().fill(0, need * PAGE);   // grown after the snapshot
    this.I.stackRestore(snap.sp);
    const A = this.I.asyncify();
    A.state = A.State.Normal;
    A.currData = snap.currData;
    A.exportCallStack = [];
    this.stats.restoreMs += performance.now() - t0;
  }

  // engine time of the running process since its last fork, in ms (the
  // driver asks for a fork only after a minimum: snapshots cost time)
  age() { return this.resident ? this.resident.age : 0; }

  // ---- calls from the driver (lib-driver.js) ----------------------------
  spawn(args) {
    const fd = this.nextFd++;
    const pid = this.nextPid++;
    const chan = new Channel(fd);
    this.channels.set(fd, chan);
    this.procs.set(pid, { pid, chan, wake: { start: args.slice(1) }, snap: null, dead: false, age: 0 });
    this.log(`[kernel] spawn pid ${pid} fd ${fd}: ${args.join(' ')}`);
    return { pid, fd };
  }

  kill(pid) {
    const p = this.procs.get(pid);
    if (!p) return;
    p.dead = true;
    this.release(p.snap);
    p.snap = null;
    if (this.resident === p) this.resident = null;
    this.procs.delete(pid);
  }

  close(fd) {
    const c = this.channels.get(fd);
    if (c) { c.closed = true; this.channels.delete(fd); }
  }

  driverWrite(fd, bytes) {
    const c = this.channels.get(fd);
    if (c) c.toEngine.push(bytes);
  }

  driverRead(fd, max) {
    const c = this.channels.get(fd);
    if (!c) return { data: new Uint8Array(0) };
    this.runUntilData(c);
    // an fd sent with CHLD comes with the first byte of that message
    let limit = max, passedFd;
    if (c.passed.length) {
      const at = c.passed[0].offset - c.toDriver.consumed;
      if (at > 0) limit = Math.min(limit, at);
      else { passedFd = c.passed.shift().fd; }
    }
    const data = c.toDriver.read(limit);
    return passedFd === undefined ? { data } : { data, passedFd };
  }

  driverPending(fd) {
    const c = this.channels.get(fd);
    if (!c) return true;
    this.runUntilData(c);
    return c.toDriver.length > 0 || c.eof;
  }

  // ---- calls from the engine (lib-engine.js) ----------------------------
  engineWrite(bytes) { if (this.current && !this.current.closed) this.current.toDriver.push(bytes); }

  engineRead(heap, ptr, len) {
    const c = this.current;
    if (!c || c.closed) return -1;
    if (!c.toEngine.length) return 0;
    const d = c.toEngine.read(len);
    heap.set(d, ptr);
    return d.length;
  }

  engineSuspend(kind, wakeUp, time) { this.suspension = { kind, wakeUp, time }; }

  // ---- scheduling -------------------------------------------------------
  procOf(chan) {
    for (const p of this.procs.values()) if (p.chan === chan) return p;
    return null;
  }

  runUntilData(chan) {
    while (chan.toDriver.length === 0 && !chan.eof && !chan.closed) {
      const p = this.procOf(chan);
      if (!p) { chan.eof = true; break; }
      this.run(p);
    }
  }

  // Run process p until it suspends or ends.
  run(p) {
    if (this.resident !== p) {
      if (p.wake && p.wake.start) {
        this.restoreSnapshot(this.pristine);
      } else if (p.snap) {
        this.restoreSnapshot(p.snap);
        this.stats.restores++;
        this.release(p.snap);
        p.snap = null;
        p.age = 0;
      } else {
        throw new Error(`kernel: process ${p.pid} has no state`);
      }
      this.resident = p;
    }
    const wake = p.wake;
    p.wake = null;
    this.current = p.chan;
    this.suspension = null;
    const t0 = performance.now();
    let ended = false;
    try {
      if (wake.start) this.engine.callMain(wake.start);
      else wake.fn(wake.value);
    } catch (e) {
      if (!(e && (e.name === 'ExitStatus' || e === 'unwind'))) {
        this.log(`[kernel] engine pid ${p.pid} failed: ${e && e.stack || e}`);
      }
      ended = true;
    }
    const dt = performance.now() - t0;
    this.stats.runMs += dt;
    p.age += dt;
    const s = this.suspension;
    this.suspension = null;
    if (!s || ended) {
      p.dead = true;
      p.chan.eof = true;
      if (this.resident === p) this.resident = null;
      this.log(`[kernel] engine pid ${p.pid} ended`);
      return;
    }
    if (s.kind === 'wait') {
      p.wake = { fn: s.wakeUp, value: 0 };
    } else if (s.kind === 'fork') {
      this.fork(p, s);
    }
  }

  fork(p, s) {
    this.stats.forks++;
    const snap = this.takeSnapshot();
    const fd = this.nextFd++;
    const pid = this.nextPid++;
    const chan = new Channel(fd);
    this.channels.set(fd, chan);
    const child = { pid, chan, wake: { fn: s.wakeUp, value: 0 }, snap: null, dead: false, age: 0 };
    this.procs.set(pid, child);
    p.snap = snap;
    p.wake = { fn: s.wakeUp, value: pid };
    this.resident = child;
    // the parent's message, as fork.c sends it natively: CHLD, time, pid + fd
    const msg = new Uint8Array(12);
    const dv = new DataView(msg.buffer);
    msg.set([67, 72, 76, 68]);                  // "CHLD"
    dv.setUint32(4, s.time >>> 0, true);
    dv.setUint32(8, pid, true);
    p.chan.passed.push({ offset: p.chan.toDriver.consumed + p.chan.toDriver.length, fd });
    p.chan.toDriver.push(msg);
  }
}

if (typeof module !== 'undefined') module.exports = { Kernel };
