// Phase 2 test in Chrome: driver + engine + kernel in one worker.
importScripts('kernel.js', 'texpresso-xetex.js', 'texpresso.js');
const LSR = ['/var/lib/texmf/ls-R', '/usr/share/texmf/ls-R', '/usr/share/texlive/texmf-dist/ls-R', '/usr/local/share/texmf/ls-R'];
const env = { TEXPRESSO_LSR: '/lsr.txt', XDG_CACHE_HOME: '/cache' };
function fill(FS, index, bin) {
  for (const [p, off, len] of index) {
    FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
    FS.writeFile(p, bin.subarray(off, off + len));
    FS.utime(p, 1700000000000, 1700000000000);
  }
  FS.writeFile('/lsr.txt', LSR.join('\n') + '\n');
  FS.chdir('/project');
}
onmessage = async (ev) => {
  const edits = ev.data.edits;
  const t0 = performance.now();
  const [index, bin] = await Promise.all([fetch('bundle.json').then(r => r.json()), fetch('bundle.bin').then(r => r.arrayBuffer()).then(b => new Uint8Array(b))]);
  const log = [];
  const kernel = new Kernel({ log: s => log.push(s) });
  const engine = await createEngine({ kernel, preRun: [m => Object.assign(m.ENV, env)], print: s => log.push('[e] ' + s), printErr: s => log.push('[e] ' + s) });
  kernel.attachEngine(engine);
  fill(engine.FS, index, bin);
  let onLine = () => {};
  const out = [];
  const drv = await createDriver({ kernel, preRun: [m => Object.assign(m.ENV, env)], print: s => { out.push(s); onLine(s); }, printErr: s => log.push('[d] ' + s) });
  fill(drv.FS, index, bin);
  const tReady = performance.now() - t0;
  const cstr = (s, extra = 0) => { const b = new TextEncoder().encode(s); const p = drv._malloc(b.length + 1 + extra); drv.HEAPU8.set(b, p); drv.HEAPU8.fill(0, p + b.length, p + b.length + 1 + extra); return [p, b.length]; };
  const inc = [];
  const walk = d => { inc.push(d); for (const e of drv.FS.readdir(d)) if (e !== '.' && e !== '..' && drv.FS.isDir(drv.FS.stat(d + '/' + e).mode)) walk(d + '/' + e); };
  walk('/project/template');
  const [incPtr] = cstr(inc.map(d => d + '\0').join(''), 1);
  const [mainPtr] = cstr('main.tex');
  drv._txp_wasm_init(mainPtr, incPtr);
  const input = s => { const [p, n] = cstr(s); drv._txp_wasm_input(p, n); drv._free(p); };
  drv.FS.mkdirTree('/exp');
  input('(export-png "/exp" 800)(export-range 0 2)(rescan)');
  const results = [];
  const pages = {};
  function settle(label, finishing) {
    const s = performance.now(); let first = null;
    onLine = l => { const m = l.match(/^\(page-image (\d+) \d+ \d "([^"]*)"/); if (m) { if (first === null) first = performance.now() - s; pages[m[1]] = m[2]; } };
    while (drv._txp_wasm_tick()) {}
    const firstDone = performance.now() - s;
    if (finishing) for (;;) { while (drv._txp_wasm_tick()) {} if (!drv._txp_wasm_idle()) break; }
    results.push({ label, firstPageMs: first && Math.round(first), visibleDoneMs: Math.round(firstDone), withRerunsMs: Math.round(performance.now() - s) });
  }
  settle('first run', true);
  for (const [file, from, to] of edits) {
    const path = '/project/' + file;
    const text = new TextDecoder().decode(drv.FS.readFile(path)).replace(from, to);
    drv.FS.writeFile(path, text);
    drv._txp_wasm_debug();
    const mark = log.length, omark = out.length;
    input(`(open ${JSON.stringify(file)} ${JSON.stringify(text)})`);
    self.lastEditLog = () => log.slice(mark).filter(l => !/priority/.test(l)).slice(0, 40).concat(['--- out:'], out.slice(omark).filter(l => !/^\((append|lookup|input-file)/.test(l)).slice(0, 20));
    drv._txp_wasm_debug();
    settle(`edit "${from}"`, true);
  }
  const images = {};
  for (const [p, f] of Object.entries(pages)) images[p] = Array.from(drv.FS.readFile(f));
  postMessage({ tReady: Math.round(tReady), results, stats: kernel.stats, memMiB: Math.round(kernel.memory().length / 1048576), images, lastEdit: self.lastEditLog && self.lastEditLog(), errors0: log.filter(l => /failed|abort|kernel|rerun|rolling|process\]|Abort|error/i.test(l)).slice(-40), outTail: out.filter(l => !/^\((append|lookup|input-file)/.test(l)).slice(-15) });
};
