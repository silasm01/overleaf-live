// Node test of the WASM TeXpresso (driver + engine + kernel), with the real
// file system (NODERAWFS builds). It sends the same commands as the helper.
//
//   node node-live.cjs <project dir> <export dir> [edit-file edit-from edit-to]...
//
// Env: TEXPRESSO_LSR (file with the ls-R paths), XDG_CACHE_HOME (format),
//      DRIVER_JS, ENGINE_JS (built modules), RANGE (export range, "0 2").
'use strict';
const fs = require('fs');
const path = require('path');
const { Kernel } = require('../js/kernel.js');

const [proj, exportDir, ...edits] = process.argv.slice(2);
const DRIVER_JS = process.env.DRIVER_JS || '/opt/wasm/build/driver/node/texpresso.js';
const ENGINE_JS = process.env.ENGINE_JS || '/opt/wasm/build/engine/kernel/texpresso-xetex.js';
const env = { TEXPRESSO_LSR: process.env.TEXPRESSO_LSR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/tmp/wcache' };
const verbose = !!process.env.VERBOSE;

// NODERAWFS builds write stdout with fs.writeSync(1): catch these lines
let stdoutLine = () => {};
{
  const orig = fs.writeSync;
  let pending = '';
  fs.writeSync = function (fd, buf, ...rest) {
    if (fd !== 1) return orig.call(fs, fd, buf, ...rest);
    const text = typeof buf === 'string' ? buf : Buffer.from(buf.buffer, buf.byteOffset + (rest[0] || 0), rest[1] ?? buf.length).toString('utf8');
    pending += text;
    let k;
    while ((k = pending.indexOf('\n')) >= 0) { stdoutLine(pending.slice(0, k)); pending = pending.slice(k + 1); }
    return typeof buf === 'string' ? Buffer.byteLength(buf) : (rest[1] ?? buf.length);
  };
}

function includeDirs(dir) {
  // as the helper: latexmkrc TEXINPUTS "template//" -> the folder and its subfolders
  const out = [];
  const t = path.join(dir, 'template');
  if (!fs.existsSync(t)) return out;
  const walk = d => { out.push(d); for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(d, e.name)); };
  walk(t);
  return out;
}

(async () => {
  const t0 = performance.now();
  const ms = () => (performance.now() - t0).toFixed(0).padStart(6) + ' ms';
  const kernel = new Kernel({ log: s => verbose && console.error(s) });
  const engine = await require(ENGINE_JS)({
    kernel, preRun: [m => Object.assign(m.ENV, env)],
    print: s => verbose && console.error('[engine] ' + s), printErr: s => verbose && console.error('[engine] ' + s),
  });
  kernel.attachEngine(engine);
  const out = [];
  let onLine = () => {};
  stdoutLine = s => { out.push(s); onLine(s); };
  const drv = await require(DRIVER_JS)({
    kernel, preRun: [m => Object.assign(m.ENV, env)],
    print: s => { out.push(s); onLine(s); }, printErr: s => verbose && console.error('[driver] ' + s),
  });
  console.log(`${ms()}  modules ready`);
  process.chdir(proj);

  const cstr = (s, extra = 0) => { const b = Buffer.from(s, 'utf8'); const p = drv._malloc(b.length + 1 + extra);
    drv.HEAPU8.set(b, p); drv.HEAPU8.fill(0, p + b.length, p + b.length + 1 + extra); return [p, b.length]; };
  const inc = includeDirs(proj);
  const incStr = inc.map(d => d + '\0').join('');
  const [incPtr] = cstr(incStr, 1);
  const [mainPtr] = cstr('main.tex');
  if (!drv._txp_wasm_init(mainPtr, incPtr)) throw new Error('init failed');
  const input = s => { const [p, n] = cstr(s); drv._txp_wasm_input(p, n); drv._free(p); };
  fs.mkdirSync(exportDir, { recursive: true });
  const range = (process.env.RANGE || '0 2');
  input(`(export-png "${exportDir}" 800)(export-range ${range})(rescan)`);

  // run until idle; report the first page and the end
  async function settle(label) {
    const s = performance.now();
    let first = null, count = null, done = false;
    onLine = l => {
      let m = l.match(/^\(page-image (\d+) (\d+) (\d)/);
      if (m && first === null) first = performance.now() - s;
      m = l.match(/^\(page-count (\d+) (\d)\)/);
      if (m) { count = +m[1]; done = m[2] === '1'; }
    };
    for (let rounds = 0; ; rounds++) {
      while (drv._txp_wasm_tick()) {}
      if (!drv._txp_wasm_idle()) break;
    }
    const total = performance.now() - s;
    console.log(`${ms()}  ${label}: first page image after ${first === null ? '-' : first.toFixed(0) + ' ms'}, ` +
      `done after ${total.toFixed(0)} ms, pages ${count}${done ? '' : ' (not done)'}`);
  }

  await settle('first run');
  for (let i = 0; i + 2 < edits.length + 1; i += 3) {
    const [file, from, to] = edits.slice(i, i + 3);
    const text = fs.readFileSync(path.join(proj, file), 'utf8');
    if (!text.includes(from)) throw new Error(`"${from}" not in ${file}`);
    const changed = text.replace(from, to);
    fs.writeFileSync(path.join(proj, file), changed);
    input(`(open ${JSON.stringify(file)} ${JSON.stringify(changed)})`);
    await settle(`edit ${file}: "${from}" -> "${to}"`);
  }
  const st = kernel.stats;
  console.log(`kernel: ${st.forks} forks, ${st.restores} restores, snapshots ${st.snapMs.toFixed(0)} ms ` +
    `(${st.pagesCopied} pages of 64 KiB copied), restores ${st.restoreMs.toFixed(0)} ms, engine ${st.runMs.toFixed(0)} ms, ` +
    `memory ${(kernel.memory().length / 1048576).toFixed(0)} MiB`);
  fs.writeFileSync(path.join(exportDir, 'stdout.txt'), out.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
