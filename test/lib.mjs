// lib.mjs -- drives the browser engine (extension/engine/worker.js) in
// headless Chrome for the tests: start a project, edit, wait, read pages,
// errors, clicks and carets. The messages are the same as content.js sends.
import fs from 'fs';
import path from 'path';

// --- zip (stored, no compression): the project as Overleaf's download ------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
export function makeZip(files) {
  const parts = [], dir = [];
  let off = 0;
  for (const [name, data0] of files) {
    const data = Buffer.from(data0);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(off, 42);
    parts.push(h, n, data);
    dir.push(c, n);
    off += 30 + n.length + data.length;
  }
  const d = Buffer.concat(dir);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.size, 8); e.writeUInt16LE(files.size, 10);
  e.writeUInt32LE(d.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, d, e]);
}

// all files of a folder (rel path -> Buffer), without .git and PDFs
export function readProject(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith('.pdf') || !p.includes('/examples/')) files.set(path.relative(dir, p), fs.readFileSync(p));
    }
  };
  walk(dir);
  return files;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- one engine ---------------------------------------------------------------
let nextId = 1;
export class Engine {
  constructor(page) { this.page = page; this.id = 'e' + nextId++; this.seen = 0; this.all = []; this.texts = new Map(); }

  async open(files, { main = 'main.tex', first = 0, last = 5 } = {}) {
    for (const [rel, data] of files) if (rel.endsWith('.tex')) this.texts.set(rel, data.toString('utf8'));
    await this.page.evaluate((id) => window.startEngine(id), this.id);
    this.mark();
    const zip = makeZip(files).toString('base64');
    await this.send({ type: 'hello', project: 'test', main });
    await this.send({ type: 'view', first, last });
    await this.send({ type: 'project', zip });
    await this.waitDone(600000);
    await this.settle();
  }

  // a project from a zip (base64), as content.js sends it
  async openZip(zip, { main = 'main.tex', first = 0, last = 5 } = {}) {
    await this.page.evaluate((id) => window.startEngine(id), this.id);
    this.mark();
    await this.send({ type: 'hello', project: 'test', main });
    await this.send({ type: 'view', first, last });
    await this.send({ type: 'project', zip });
    await this.waitDone(600000);
    await this.settle();
  }

  send(msg) { return this.page.evaluate(([id, m]) => window.sendTo(id, m), [this.id, msg]); }

  // new messages (all are kept in this.all; this.since: from the last mark)
  async poll() {
    const m = await this.page.evaluate(([id, from]) => window.takeMsgs(id, from), [this.id, this.seen]);
    this.seen += m.length;
    this.all.push(...m);
    return m;
  }
  mark() { this.markAt = this.all.length; this.markTime = null; }
  get since() { return this.all.slice(this.markAt); }

  async waitFor(pred, timeout = 20000, what = 'a message') {
    const t0 = Date.now();
    for (;;) {
      await this.poll();
      const hit = this.since.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > timeout) throw new Error(`timeout (${timeout} ms) waiting for ${what}`);
      await sleep(20);
    }
  }

  // the document (or the part in view) is typeset again after the last mark
  waitDone(timeout = 30000) {
    return this.waitFor(m => ((m.type === 'count' || m.type === 'page') && m.done) ||
      (m.type === 'status' && /stopped|error/.test(m.text)), timeout, 'the end of the document');
  }

  // no message for quiet ms (the second pass starts 2 s after an edit)
  async settle(quiet = 3000, timeout = 60000) {
    const t0 = Date.now();
    let last = Date.now(), n = this.all.length;
    for (;;) {
      await this.poll();
      if (this.all.length !== n) { n = this.all.length; last = Date.now(); }
      if (Date.now() - last >= quiet) return;
      if (Date.now() - t0 > timeout) throw new Error('the engine did not become idle');
      await sleep(50);
    }
  }

  // keepMark: part of a series of edits (restarted() etc. look at all of it)
  async edit(rel, text, { keepMark = false } = {}) {
    this.texts.set(rel, text);
    if (!keepMark) this.mark();
    this.editAt = await this.page.evaluate(() => performance.now());
    await this.send({ type: 'edit', path: rel, text });
  }

  // ms from the last edit to the first new page (null: no page)
  firstPageMs() {
    const p = this.since.find(m => m.type === 'page');
    return p ? Math.round(p.t - this.editAt) : null;
  }

  // ms from the last edit to the end of the document (or the pages in view)
  doneMs() {
    const p = this.since.find(m => (m.type === 'count' || m.type === 'page') && m.done);
    return p ? Math.round(p.t - this.editAt) : null;
  }

  // ms from the last edit until the viewer can show the fix: the first
  // errors message without the error (the pages that did not change are
  // not sent again), or the first page
  fixMs(errorText) {
    const p = this.since.find(m => m.type === 'page' || (m.type === 'errors' && !m.lines.some(l => l.includes(errorText))));
    return p ? Math.round(p.t - this.editAt) : null;
  }

  // the engine stopped and started again (a restart), since the mark
  restarted() {
    return this.since.some(m => (m.type === 'status' && /stopped|starting the engine/.test(m.text)) ||
      (m.type === 'debug' && /failed|engine error/.test(m.text)));
  }
  aborted() { return this.since.some(m => m.type === 'debug' && /fatal TeX error/.test(m.text)); }

  errors() {
    for (let i = this.all.length - 1; i >= 0; i--) if (this.all[i].type === 'errors') return this.all[i].lines;
    return [];
  }
  pageCount() {
    for (let i = this.all.length - 1; i >= 0; i--) {
      const m = this.all[i];
      if ((m.type === 'count' || m.type === 'page') && m.done) return m.count;
    }
    return null;
  }
  pages() { return this.page.evaluate((id) => window.pagesOf(id), this.id); }
  debugLog() { return this.all.filter(m => m.type === 'debug').map(m => m.text); }

  async ask(msg, type, timeout = 10000) {
    this.mark();
    await this.send(msg);
    return this.waitFor(m => m.type === type || m.type === 'notReady' ||
      (m.type === 'debug' && /not followed/.test(m.text)), timeout, type);
  }
  pageMap(page) { return this.ask({ type: 'pageMaps', first: page, last: page }, 'pageMap'); }
  click(page, x, y) { return this.ask({ type: 'click', page, x, y }, 'goto'); }
  cursor(rel, line, column) { return this.ask({ type: 'cursor', path: rel, line, column }, 'caret'); }

  close() { return this.page.evaluate((id) => window.stopEngine(id), this.id); }
}

// --- results ------------------------------------------------------------------
export class Results {
  constructor() { this.list = []; this.current = null; }
  // known: a bug that is known and not fixed yet (text: what it is); its
  // test is shown as KNOWN and does not fail the run
  async test(name, fn, { known = null } = {}) {
    const t0 = Date.now();
    const r = { name, ok: true, notes: [] };
    this.current = r;
    try { await fn(r); } catch (e) { r.ok = false; r.notes.push('error: ' + (e && e.stack || e)); }
    r.ms = Date.now() - t0;
    if (known && !r.ok) { r.known = true; r.ok = true; r.notes.unshift('known bug: ' + known); }
    else if (known) r.notes.unshift('passes now: remove "known" from this test');
    this.list.push(r);
    console.log(`${r.known ? 'KNOWN' : r.ok ? 'PASS' : 'FAIL'}  ${name}  (${(r.ms / 1000).toFixed(1)} s)`);
    for (const n of r.notes) console.log('      ' + n.split('\n').join('\n      '));
    return r;
  }
  check(cond, text) {
    if (!cond) { this.current.ok = false; this.current.notes.push('✗ ' + text); }
    return !!cond;
  }
  note(text) { this.current.notes.push(text); }
}
