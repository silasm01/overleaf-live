// worker.js -- the browser engine of Overleaf Live: does the work of the WSL
// helper (helper/overleaf_live.py), but with TeXpresso in WebAssembly (the
// driver texpresso.wasm and the engine texpresso-xetex.wasm, connected by
// kernel.js). Runs in a Web Worker of the offscreen document.
//
// Messages: the same JSON messages as the helper's WebSocket, wrapped:
//   in:  {client, msg} | {client, closed: true} | {reset: true}
//   out: {to: client | null (all tabs of the project), msg}
'use strict';
importScripts('kernel.js', 'texpresso-xetex.js', 'texpresso.js', 'xzdec.js', 'texlive.js', 'bibtex.js');

const PROJECT = '/project';
const EXPORT = '/export';

// --- TeX files: TeX Live 2025 (the version of Overleaf), downloaded on demand -
// (texlive.js). The repository is the frozen end of TeX Live 2025
// ("tlnet-final"); offscreen.js can give others (chrome.storage "texRepos").
let REPOS = [
  'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final',
  'https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/tlnet-final',
  'https://mirrors.tuna.tsinghua.edu.cn/tex-historic-archive/systems/texlive/2025/tlnet-final',
];
let TL_VERSION = '2025-final';
let tl = null, tlReady = null;
function getTl() {
  if (!tlReady) {
    tl = new TexLive({ repos: REPOS, version: TL_VERSION, log,
      progress: (text) => status(text, true) });
    tlReady = tl.init(createXz).catch((e) => { tlReady = null; throw e; });
  }
  return tlReady.then(() => tl);
}

// The engine's build: a new build needs a new format.
let engineKeyP = null;
function engineKey() {
  if (!engineKeyP) engineKeyP = fetch('texpresso-xetex.wasm').then(r => r.arrayBuffer()).then(b => {
    const a = new Uint8Array(b);
    let h = a.length;
    for (let i = 0; i < a.length; i += 997) h = (Math.imul(h, 31) + a[i]) | 0;
    return (h >>> 0).toString(36);
  });
  return engineKeyP;
}

function put(FS, path, data, time = TL_FIXED_TIME) {
  FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
  FS.writeFile(path, data);
  FS.utime(path, time, time);
}

// --- the format, kept between sessions (Origin Private File System) --------
const FORMAT_DIR = '/cache/texpresso/format';
async function formatStore() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(`format-${TL_VERSION}-${await engineKey()}`, { create: true });
}
async function haveFormat() {
  const dir = await formatStore();
  for await (const [name] of dir.entries()) if (name.endsWith('.fmt')) return true;
  return false;
}
async function restoreFormat(FS) {
  try {
    const dir = await formatStore();
    for await (const [name, handle] of dir.entries()) {
      const data = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      put(FS, `${FORMAT_DIR}/${name}`, data);
    }
  } catch (e) { log('no saved format: ' + e); }
}
async function saveFormat(FS) {
  let names;
  try { names = FS.readdir(FORMAT_DIR).filter(n => n !== '.' && n !== '..'); } catch { return; }
  const dir = await formatStore();
  for (const name of names) {
    try { await dir.getFileHandle(name); continue; } catch { /* not saved yet */ }
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(FS.readFile(`${FORMAT_DIR}/${name}`));
    await w.close();
    log(`format saved: ${name}`);
  }
}

// --- helpers ---------------------------------------------------------------
function log(...a) {
  console.log('[olive-engine]', ...a);
  postMessage({ to: null, msg: { type: 'debug', text: a.join(' ') } });   // content.js ignores it
}

function sexpString(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function safeRel(rel) {
  const parts = [];
  for (const p of String(rel).replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') return null;
    parts.push(p);
  }
  return parts.length ? parts.join('/') : null;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// a zip (from Overleaf's download) -> Map rel path -> bytes
async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else continue;
    const rel = safeRel(name);
    if (rel) files.set(rel, data);
  }
  return files;
}

// --- the project -------------------------------------------------------------
const P = {
  id: null,
  clients: new Set(),
  main: '',
  lua: false,
  files: new Map(),          // rel path -> bytes (the project as last sent)
  pages: new Map(),          // page -> last "page" message (for new tabs)
  lastMsg: {},               // "status", "errors", "count" -> last message
  width: 1000, first: 0, last: 0,
  run: null,                 // {kernel, engine, drv, out, sentErrors, formatSaved}
  starting: null,
  luaNoted: false,
  feedback: new Map(),       // rel path -> bytes: outputs given back (second pass)
  overleafBbl: null,         // the .bbl of Overleaf's last compile (for biblatex)
  lastActivity: 0,           // performance.now() of the last edit or view change
};

function send(msg, to = null) {
  if (to === null) {
    if (msg.type === 'status' || msg.type === 'errors' || msg.type === 'count') P.lastMsg[msg.type] = msg;
    if (msg.type === 'page') P.pages.set(msg.page, msg);
  }
  postMessage({ to, msg });
}

function status(text, busy = false) { send({ type: 'status', text, busy }); }

function findMain() {
  if (P.main && P.files.has(P.main)) return;
  const top = [...P.files.keys()].filter(f => !f.includes('/') && f.endsWith('.tex'))
    .sort((a, b) => (a !== 'main.tex') - (b !== 'main.tex') || a.localeCompare(b));
  const dec = new TextDecoder();
  for (const f of top) if (dec.decode(P.files.get(f)).includes('\\documentclass')) { P.main = f; return; }
}

// latexmkrc TEXINPUTS ("template//") -> folders for -I, as the helper does
function includeDirs() {
  const rc = P.files.get('latexmkrc');
  if (!rc) return [];
  const dirs = [];
  const all = [...P.files.keys()];
  for (let line of new TextDecoder().decode(rc).split('\n')) {
    line = line.split('#')[0];
    if (!line.includes('TEXINPUTS')) continue;
    for (const m of line.matchAll(/['"]([^'"]*)['"]/g)) {
      for (let entry of m[1].split(':')) {
        entry = entry.replace(/\$\{?repo\}?/g, '.').trim();
        if (['', '.', './', 'TEXINPUTS'].includes(entry)) continue;
        const recursive = entry.endsWith('//');
        const d = safeRel(entry.replace(/\/+$/, ''));
        if (!d) continue;
        const sub = new Set();
        for (const f of all) {
          if (!f.startsWith(d + '/')) continue;
          const parts = f.slice(d.length + 1).split('/').slice(0, -1);
          if (!recursive && parts.length) continue;
          for (let i = 0; i <= parts.length; i++) sub.add([d, ...parts.slice(0, i)].join('/'));
        }
        for (const x of [...sub].sort()) if (!dirs.includes(x)) dirs.push(x);
      }
    }
  }
  return dirs.map(d => `${PROJECT}/${d}`);
}

function writeProjectFile(rel, data) {
  if (!P.run) return;
  for (const mod of [P.run.engine, P.run.drv]) put(mod.FS, `${PROJECT}/${rel}`, data, Date.now());
}

async function start() {
  if (P.starting) return P.starting;
  P.starting = (async () => {
    stop();
    findMain();
    if (!P.files.has(P.main)) { status(`${P.main || 'main.tex'} not found in the project`); return; }
    status('starting the engine', true);
    const t0 = performance.now();
    const lap = (what) => log(`start: ${what} at ${Math.round(performance.now() - t0)} ms`);
    const tl = await getTl();
    lap('TeX Live index ready');
    // download what is surely needed, in parallel (the rest comes on demand)
    const need = projectPackages(tl, P.files);
    if (!(await haveFormat())) need.push(...FORMAT_PACKAGES, ...tl.hyphenationPackages());
    const n = await tl.prefetch(need, (k, total) => status(`downloading TeX Live packages (${k} of ${total})`, true));
    lap(`${n} packages downloaded`);
    // TEXPRESSO_SHELL_ESCAPE=2: restricted shell escape; piped input runs
    // kpsewhich and texlua in the driver's Lua sandbox (live Lua for luabridge)
    const env = { TEXPRESSO_LSR: '/lsr.txt', XDG_CACHE_HOME: '/cache', TEXPRESSO_SHELL_ESCAPE: '2' };
    const run = { out: '', sentErrors: null, formatSaved: false, failed: false, toEnd: false, passes: 0 };
    run.kernel = new Kernel({ log: s => { if (/failed/.test(s)) { run.failed = true; log(s); } } });
    run.engine = await createEngine({ kernel: run.kernel, tl, preRun: [m => Object.assign(m.ENV, env)],
      print: () => {}, printErr: () => {} });
    run.kernel.attachEngine(run.engine);
    lap('engine module ready');
    run.drv = await createDriver({ kernel: run.kernel, tl, preRun: [m => Object.assign(m.ENV, env)],
      print: line => onLine(run, line), printErr: line => { if (line.startsWith('[pipe]')) log(line); } });
    for (const mod of [run.engine, run.drv]) {
      mod.FS.writeFile('/lsr.txt', tl.setup(mod.FS));
      mod.FS.mkdirTree(PROJECT);
      // outputs of the last run (.aux, .toc, ...: the second pass), then the project
      for (const [rel, data] of P.feedback) if (!P.files.has(rel)) put(mod.FS, `${PROJECT}/${rel}`, data, Date.now());
      for (const [rel, data] of P.files) put(mod.FS, `${PROJECT}/${rel}`, data, Date.now());
      mod.FS.chdir(PROJECT);
    }
    lap('driver module ready, files written');
    await restoreFormat(run.engine.FS);
    lap('format restored');
    run.drv.FS.mkdirTree(EXPORT);
    const cstr = (s) => { const b = new TextEncoder().encode(s); const p = run.drv._malloc(b.length + 2);
      run.drv.HEAPU8.set(b, p); run.drv.HEAPU8[p + b.length] = 0; run.drv.HEAPU8[p + b.length + 1] = 0; return [p, b.length]; };
    run.cstr = cstr;
    const [incPtr] = cstr(includeDirs().map(d => d + '\0').join(''));
    const [mainPtr] = cstr(P.main);
    if (!run.drv._txp_wasm_init(mainPtr, incPtr)) { status('the engine could not start (no TeX Live index)'); return; }
    P.run = run;
    P.pages.clear();
    command(`(export-png ${sexpString(EXPORT)} ${P.width})`);
    command(`(export-range ${P.first} ${P.last})`);
    if (P.caretDebug) command('(caret-debug t)');
    command('(rescan)');
    status('typesetting', true);
  })().finally(() => { P.starting = null; });
  return P.starting;
}

function stop() {
  P.run = null;              // the modules (and the engine memory) are garbage now
}

function command(text) {
  const run = P.run;
  if (!run) return;
  const [p, n] = run.cstr(text);
  run.toEnd = false;
  try { run.drv._txp_wasm_input(p, n); } catch (e) { fail(e); return; }
  run.drv._free(p);
  pump();
}

// --- running the engine: ticks in slices, so messages still come in ---------
let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  setTimeout(step, 0);
}

function step() {
  pumping = false;
  const run = P.run;
  if (!run) return;
  const t0 = performance.now();
  let more = true;
  try {
    while (more && performance.now() - t0 < 30) more = !!run.drv._txp_wasm_tick();
  } catch (e) { fail(e); return; }
  if (run.failed) { fail(new Error('the engine stopped')); return; }
  // the format is complete once a page is out: keep it (once)
  if (!run.formatSaved && P.pages.size) {
    run.formatSaved = true;
    saveFormat(run.engine.FS).catch(e => log('format not saved: ' + e));
  }
  if (more) { pump(); return; }
  // the pages in view are done
  if (P.lastMsg.status && P.lastMsg.status.busy && P.lastMsg.status.text === 'typesetting') status('live', false);
  // after a pause in typing only (as the helper's latexmk), so that edits
  // stay fast:
  const quiet = BACKGROUND_PAUSE - (performance.now() - P.lastActivity);
  if (quiet > 0) { setTimeout(pump, quiet + 5); return; }
  // The view is done: go on to the end of the document in the background,
  // then give the outputs (.aux, .toc, ...) back as inputs (a second pass).
  try {
    if (!run.drv._txp_wasm_status()) {
      if (!run.toEnd) { run.toEnd = true; run.drv._txp_wasm_run_to_end(); pump(); return; }
    } else if (secondPass(run)) {
      return;
    }
  } catch (e) { fail(e); return; }
  // idle
  const st = run.kernel.stats;
  if (tl) log(`TeX Live: ${tl.stats.downloads} packages downloaded (${Math.round(tl.stats.downloadBytes / 1048576)} MiB), ${tl.stats.fromCache} from the store`);
  log(`idle: forks ${st.forks}, restores ${st.restores}, snapshots ${Math.round(st.snapMs)} ms, restores ${Math.round(st.restoreMs)} ms, engine ${Math.round(st.runMs)} ms`);
  if (P.lastMsg.status && P.lastMsg.status.busy) status('live', false);
}

// The second pass, as latexmk: the files the run wrote that a next run reads
// (.aux, .toc, .out, ...) go back to TeXpresso as edits, when they changed.
// TeXpresso then goes back to where it read them. If the .aux names a
// bibliography (\bibdata), BibTeX makes the .bbl first. At most 3 passes per
// change.
const BACKGROUND_PAUSE = 2000;   // ms without edits before the second pass (helper: LUA_IDLE)

function secondPass(run) {
  if (run.passes >= 3 || run.bibBusy) return run.bibBusy;
  const [p] = run.cstr('/outputs.bin');
  const count = run.drv._txp_wasm_dump_outputs(p);
  run.drv._free(p);
  if (count <= 0) return false;
  const buf = run.drv.FS.readFile('/outputs.bin');
  const outputs = new Map();
  for (let i = 0; i < buf.length; ) {
    const nl1 = buf.indexOf(10, i), nl2 = buf.indexOf(10, nl1 + 1);
    let path = new TextDecoder().decode(buf.subarray(i, nl1));
    const len = +new TextDecoder().decode(buf.subarray(nl1 + 1, nl2));
    const data = buf.slice(nl2 + 1, nl2 + 1 + len);
    i = nl2 + 1 + len;
    if (path.startsWith(PROJECT + '/')) path = path.slice(PROJECT.length + 1);
    const rel = safeRel(path);
    if (rel && !P.files.has(rel)) outputs.set(rel, data);
  }
  // BibTeX
  const job = P.main.replace(/\.tex$/, '');
  const aux = outputs.get(`${job}.aux`);
  if (aux && /\\bibdata\{/.test(new TextDecoder().decode(aux))) {
    const input = bibtexInput(outputs, job);
    if (input.key !== run.bibKey) {
      run.bibBusy = true;
      runBibtex(input, job).then((bbl) => {
        run.bibKey = input.key;
        run.bbl = bbl;
      }).catch((e) => log('bibtex: ' + e)).finally(() => { run.bibBusy = false; if (P.run === run) pump(); });
      return true;
    }
    if (run.bbl) outputs.set(`${job}.bbl`, run.bbl);
  } else if (P.overleafBbl && outputs.has(`${job}.bcf`)) {
    // biblatex: Biber does not run here; Overleaf's .bbl of its last compile
    outputs.set(`${job}.bbl`, P.overleafBbl);
  }
  const changed = [];
  for (const [rel, data] of outputs) {
    if (/\.(bcf|run\.xml)$/.test(rel)) continue;     // for Biber, not read by TeX
    const old = P.feedback.get(rel);
    if (!old || old.length !== data.length || old.some((b, k) => b !== data[k])) changed.push([rel, data]);
  }
  if (!changed.length) return false;
  run.passes++;
  log(`second pass ${run.passes}: ${changed.map(c => c[0]).join(', ')}`);
  for (const [rel, data] of changed) {
    P.feedback.set(rel, data);
    command(`(open ${sexpString(rel)} ${sexpString(new TextDecoder().decode(data))})`);
  }
  return true;
}

// The files BibTeX reads: the .aux files, the .bib files (project or TeX
// Live) and the .bst file. key: changes when BibTeX's result can change.
function bibtexInput(outputs, job) {
  const files = new Map();
  let key = '';
  const dec = new TextDecoder();
  for (const [rel, data] of outputs) {
    if (!rel.endsWith('.aux')) continue;
    files.set(rel, data);
    // only the lines BibTeX reads (not \newlabel, ... of each pass)
    key += rel + '\n' + dec.decode(data).split('\n')
      .filter(l => /^\\(citation|bibdata|bibstyle|@input)\{/.test(l)).join('\n') + '\n';
  }
  const text = [...files.values()].map(d => dec.decode(d)).join('\n');
  const names = (re) => [...text.matchAll(re)].flatMap(m => m[1].split(',')).map(n => n.trim()).filter(Boolean);
  const find = (name, ext) => {
    const file = name.endsWith(ext) ? name : name + ext;
    const mainDir = P.main.includes('/') ? P.main.slice(0, P.main.lastIndexOf('/') + 1) : '';
    for (const dir of [mainDir, '', ...includeDirs().map(d => d + '/')]) {
      const rel = safeRel(dir + file);
      if (rel && P.files.has(rel)) return P.files.get(rel);
    }
    return tl && tl.findByName(file);
  };
  for (const name of names(/\\bibdata\{([^}]*)\}/g)) {
    const data = find(name, '.bib');
    if (data) { files.set(name.endsWith('.bib') ? name : name + '.bib', data); key += `${name}:${hashBytes(data)}\n`; }
  }
  for (const name of names(/\\bibstyle\{([^}]*)\}/g)) {
    const data = find(name, '.bst');
    if (data) { files.set(name.endsWith('.bst') ? name : name + '.bst', data); key += `${name}.bst:${hashBytes(data)}\n`; }
  }
  return { files, key };
}

function hashBytes(data) {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
  return (h >>> 0).toString(16) + ':' + data.length;
}

// Runs BibTeX (bibtex.wasm, a new instance each time) and returns the .bbl.
async function runBibtex(input, job) {
  const t0 = performance.now();
  let out = '';
  const m = await createBibtex({ print: (s) => { out += s + '\n'; }, printErr: (s) => { out += s + '\n'; } });
  m.FS.mkdirTree('/work');
  m.FS.chdir('/work');
  for (const [rel, data] of input.files) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (dir) m.FS.mkdirTree(dir);
    m.FS.writeFile(rel, data);
  }
  let code;
  try { code = m.callMain([`${job}.aux`]); } catch (e) { code = e && e.status !== undefined ? e.status : 3; }
  let bbl = null;
  try { bbl = m.FS.readFile(`${job}.bbl`); } catch (e) { /* none */ }
  const warnings = out.split('\n').filter(l => /^Warning--|error message|^I (couldn't|found no)/.test(l));
  log(`bibtex: exit ${code}, ${bbl ? bbl.length : 0} bytes, ${Math.round(performance.now() - t0)} ms` +
      (warnings.length ? ` (${warnings.slice(0, 5).join('; ')})` : ''));
  return bbl;
}

function fail(e) {
  log('engine error', e, e && e.stack ? e.stack.split('\n').slice(0, 12).join(' | ') : '');
  P.run = null;
  status('TeXpresso stopped (it restarts with the next edit)', false);
}

// --- TeXpresso's output (as helper read_texpresso) ---------------------------
const pageRe = /^\(page-image (\d+) (\d+) (\d) "(.*)"(?: ([\d.]+) ([\d.]+))?\)$/;
const countRe = /^\(page-count (\d+) (\d)\)$/;
const appendRe = /^\(append out (\d+) "(.*)"\)$/;
// (synctex-target page x y h d [box x0 y0 x1 y1]): the box of a part that
// does not map 1:1 to its glyphs (\infty, \ref{...}, a picture)
// "element": the box is a picture or a TikZ element (the viewer shows only the box)
const caretRe = /^\(synctex-target (\d+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)((?: [-\d.]+){4})?( element)?\)$/;
const backRe = /^\(synctex "(.*)" (-?\d+) (-?\d+)\)$/;
// (synctex-field "path" l0 c0 l1 c1 x0 y0 x1 y1 "text"): quick edit, the
// source text of the double-clicked field (sent before its (synctex ...))
const fieldRe = /^\(synctex-field "((?:[^"\\]|\\.)*)" (\d+) (\d+) (\d+) (\d+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) "((?:[^"\\]|\\.)*)"\)$/;
const truncRe = /^\(truncate out (\d+)\)$/;
const unescape = s => s.replace(/\\(.)/g, (_, c) => c === 'n' ? '\n' : c);

function onLine(run, line) {
  if (run !== P.run && P.run) return;
  let m;
  if ((m = line.match(pageRe))) {
    let data;
    try { data = run.drv.FS.readFile(m[4]); run.drv.FS.unlink(m[4]); } catch { return; }
    send({ type: 'page', page: +m[1], count: +m[2], done: m[3] === '1', png: toBase64(data),
      w: parseFloat(m[5] || '595.28'), h: parseFloat(m[6] || '841.89') });
  } else if ((m = line.match(caretRe))) {
    const caret = { type: 'caret', page: +m[1], x: +m[2], y: +m[3], h: +m[4], d: +m[5] };
    if (m[6]) caret.box = m[6].trim().split(' ').map(Number);
    if (m[7]) caret.element = true;
    send(caret);
  } else if (line.startsWith('(synctex-debug ')) {
    send(parseCaretDebug(line));
  } else if (line.startsWith('(synctex-elements ')) {
    send(parseElements(line));
  } else if ((m = line.match(fieldRe))) {
    let path = unescape(m[1]);
    if (path.startsWith(PROJECT + '/')) path = path.slice(PROJECT.length + 1);
    const rel = safeRel(path);
    if (rel) send({ type: 'field', path: rel, from: [+m[2], +m[3]], to: [+m[4], +m[5]],
      box: [+m[6], +m[7], +m[8], +m[9]], text: unescape(m[10]) });
  } else if ((m = line.match(backRe))) {
    let path = unescape(m[1]);
    if (path.startsWith(PROJECT + '/')) path = path.slice(PROJECT.length + 1);
    const rel = safeRel(path);
    if (rel) send({ type: 'goto', path: rel, line: +m[2], column: Math.max(0, +m[3]) });
  } else if ((m = line.match(countRe))) {
    send({ type: 'count', count: +m[1], done: m[2] === '1' });
  } else if ((m = line.match(appendRe))) {
    run.out = run.out.slice(0, +m[1]) + unescape(m[2]);
  } else if ((m = line.match(truncRe))) {
    run.out = run.out.slice(0, +m[1]);
  } else if (line === '(flush)') {
    reportErrors(run);
  }
}

// (synctex-debug page n line col x y h d box ... m x0 y0 x1 y1 ...): the
// caret of every character near the cursor (the debug panel draws them)
function parseCaretDebug(line) {
  const v = line.slice(1, -1).split(' ').slice(1).map(Number);
  const page = v[0], n = v[1];
  let i = 2;
  const points = [];
  for (let k = 0; k < n; k++, i += 7) points.push(v.slice(i, i + 7));
  const m = v[i++] || 0;
  const boxes = [];
  for (let k = 0; k < m; k++, i += 4) boxes.push(v.slice(i, i + 4));
  return { type: 'caretDebug', page, points, boxes };
}

// (synctex-elements page n kind line end index depth x0 y0 x1 y1 "file" l0 c0 l1 c1 ...):
// the TikZ elements of a page (debug panel)
function parseElements(line) {
  const toks = [];
  const re = /"((?:[^"\\]|\\.)*)"|[^\s()]+/g;
  let m;
  while ((m = re.exec(line))) toks.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[0]);
  const page = +toks[1], n = +toks[2], elements = [];
  for (let i = 3, k = 0; k < n; k++, i += 14) {
    elements.push({ kind: toks[i], line: +toks[i + 1], end: +toks[i + 2], index: +toks[i + 3],
      depth: +toks[i + 4], box: toks.slice(i + 5, i + 9).map(Number), file: toks[i + 9],
      src: toks.slice(i + 10, i + 14).map(Number) });
  }
  return { type: 'caretElements', page, elements };
}

function reportErrors(run) {
  const lines = [];
  for (const chunk of run.out.split('\n! ').slice(1)) {
    const first = chunk.split('\n')[0].trim();
    const loc = chunk.match(/\nl\.(\d+)/);
    lines.push(first + (loc ? ` (line ${loc[1]})` : ''));
  }
  if (JSON.stringify(lines) !== JSON.stringify(run.sentErrors)) {
    run.sentErrors = lines;
    send({ type: 'errors', lines: lines.slice(0, 20) });
  }
}

// --- messages from the tabs (as the helper's handlers) -----------------------
const handlers = {
  hello(client, msg) {
    const id = String(msg.project || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) return;
    if (P.id !== id) {          // one project at a time: another one takes over
      stop();
      Object.assign(P, { id, files: new Map(), pages: new Map(), lastMsg: {}, main: '', luaNoted: false,
        feedback: new Map(), overleafBbl: null });
    }
    P.clients.add(client);
    if (msg.main) P.main = msg.main;
    P.lua = !!msg.lua;
    for (const kind of ['status', 'errors', 'count']) if (P.lastMsg[kind]) send(P.lastMsg[kind], client);
    if (!P.run) status('waiting for the project files', true);
  },
  async project(client, msg) {
    P.files = await unzip(fromBase64(msg.zip));
    log(`project ${P.id}: ${P.files.size} files`);
    if (P.run) {
      for (const [rel, data] of P.files) writeProjectFile(rel, data);
      command('(rescan)');
      status('project files updated', false);
    } else {
      await start();
    }
  },
  async edit(client, msg) {
    const rel = safeRel(msg.path || '');
    if (!rel) return;
    const text = String(msg.text || '');
    P.files.set(rel, new TextEncoder().encode(text));
    if (!P.run) { await start(); }
    writeProjectFile(rel, P.files.get(rel));
    P.lastActivity = performance.now();
    if (P.run) P.run.passes = 0;
    command(`(open ${sexpString(rel)} ${sexpString(text)})`);
  },
  // a file from Overleaf's last compile: output.bbl (Biber, for biblatex)
  file(client, msg) {
    if (msg.path !== 'output.bbl' || typeof msg.text !== 'string') return;
    const data = new TextEncoder().encode(msg.text);
    const old = P.overleafBbl;
    if (old && old.length === data.length && old.every((b, k) => b === data[k])) return;
    P.overleafBbl = data;
    log(`Overleaf's .bbl: ${data.length} bytes`);
    if (P.run) { P.run.passes = 0; pump(); }
  },
  view(client, msg) {
    P.first = Math.max(0, msg.first | 0);
    P.last = Math.max(P.first, Math.min(P.first + 20, msg.last | 0));
    P.lastActivity = performance.now();
    for (let page = P.first; page <= P.last; page++) if (P.pages.has(page)) send(P.pages.get(page), client);
    command(`(export-range ${P.first} ${P.last})`);
  },
  width(client, msg) {
    const width = Math.max(200, Math.min(4000, msg.width | 0 || 1000));
    if (width === P.width) return;
    P.width = width;
    P.pages.clear();
    command(`(export-png ${sexpString(EXPORT)} ${P.width})`);
  },
  cursor(client, msg) {
    const rel = safeRel(msg.path || '');
    if (!rel || !P.run) return;
    command(`(synctex-forward ${sexpString(`${PROJECT}/${rel}`)} ${Math.max(1, msg.line | 0)} ${Math.max(0, msg.column | 0)})`);
  },
  scan(client, msg) {
    if (!P.run) return;
    command(`(synctex-scan ${Math.max(0, msg.page | 0)} ${(+msg.x || 0).toFixed(2)} ${(+msg.y || 0).toFixed(2)})`);
  },
  lua(client, msg) { P.lua = !!msg.on; },
  // the caret map of every source line on one page (debug panel, whole page)
  caretElements(client, msg) {
    if (P.run) command(`(caret-elements ${Math.max(0, msg.page | 0)})`);
  },
  caretMap(client, msg) {
    if (P.run) command(`(caret-map ${Math.max(0, msg.page | 0)})`);
  },
  caretDebug(client, msg) {
    P.caretDebug = !!msg.on;
    if (P.run) command(`(caret-debug ${P.caretDebug ? 't' : 'nil'})`);
  },
  ping() {},
};

let queue = Promise.resolve();   // one message after the other (some are async)
onmessage = (e) => {
  const d = e.data;
  queue = queue.then(async () => {
    try {
      if (d.reset) { P.clients.clear(); return; }
      if (d.config) {
        if (Array.isArray(d.config.repos) && d.config.repos.length && !tl) {
          REPOS = d.config.repos;
          TL_VERSION = d.config.version || ('custom-' + (hashString(REPOS.join(' ')) % 100000));
        }
        return;
      }
      if (d.closed) {
        P.clients.delete(d.client);
        // no tab left: stop after a minute (a tab may reconnect, e.g. after a
        // restart of the service worker)
        if (!P.clients.size) setTimeout(() => { if (!P.clients.size) stop(); }, 60000);
        return;
      }
      const h = handlers[d.msg && d.msg.type];
      if (h) await h(d.client, d.msg);
    } catch (err) {
      log('error', err);
      status(`engine error: ${err.message || err}`, false);
    }
  });
};
