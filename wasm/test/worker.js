// Phase 1 test: runs texpresso-xetex (WASM) on the template in a Web Worker.
importScripts('texpresso-xetex.js');
let bundle;
async function load() {
  const [index, bin] = await Promise.all([
    fetch('bundle.json').then(r => r.json()),
    fetch('bundle.bin').then(r => r.arrayBuffer())]);
  bundle = { index, bin: new Uint8Array(bin) };
}
async function run(files, args) {
  const log = [];
  const env = { TEXPRESSO_LSR: '/lsr.txt', XDG_CACHE_HOME: '/cache', SOURCE_DATE_EPOCH: '1763000000' };
  const m = await createEngine({ print: s => log.push(s), printErr: s => log.push(s),
    preRun: [mod => Object.assign(mod.ENV, env)] });
  const FS = m.FS;
  for (const [path, off, len] of bundle.index) {
    FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    FS.writeFile(path, bundle.bin.subarray(off, off + len)); FS.utime(path, 1700000000000, 1700000000000);
  }
  for (const [path, data] of Object.entries(files)) {
    FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    FS.writeFile(path, data);
  }
  FS.writeFile('/lsr.txt', ['/var/lib/texmf/ls-R','/usr/share/texmf/ls-R','/usr/share/texlive/texmf-dist/ls-R','/usr/local/share/texmf/ls-R'].join('\n') + '\n');
  FS.chdir('/project');
  const t0 = performance.now();
  let code; try { code = m.callMain(args); } catch (e) { log.push('exception: ' + e); }
  const ms = performance.now() - t0;
  const read = p => { try { return FS.readFile(p); } catch { return null; } };
  const keep = {};
  for (const p of ['/project/main.aux', '/project/main.toc', '/project/main.out', '/project/main-usage.tex'])
    { const d = read(p); if (d) keep[p] = d; }
  let fmt = null;
  try { for (const f of FS.readdir('/cache/texpresso/format')) if (f.endsWith('.fmt') || f.endsWith('.deps')) keep['/cache/texpresso/format/' + f] = read('/cache/texpresso/format/' + f); } catch {}
  return { ms, code, log, keep, xdv: read('/project/main.xdv') };
}
onmessage = async () => {
  const t0 = performance.now();
  await load();
  const tLoad = performance.now() - t0;
  const r1 = await run({}, ['-texlive', 'main.tex']);
  r1.fmtLog = r1.log.filter(l => /Format generation/.test(l));           // format + pass 1
  const r2 = await run(r1.keep, ['-texlive', 'main.tex']);      // pass 2 (with .aux, cached format)
  const r3 = await run(r2.keep, ['-texlive', 'main.tex']);      // pass 3 (same as a recompile)
  const pages = r => (r.log.join('\n').match(/Output written on main\.xdv \((\d+) page/) || [])[1];
  postMessage({ fmt: [r1, r2, r3].map(r => r.log.some(l => /Format generation/.test(l))), tLoad, t1: r1.ms, t2: r2.ms, t3: r3.ms, pages: [pages(r1), pages(r2), pages(r3)],
    errors: r3.log.filter(l=>!/priority|rank:/.test(l)).filter(l => l.startsWith('!')).slice(0, 12), tail: r3.log.slice(-4), xdv: r3.xdv });
};
