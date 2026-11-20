// suites.mjs -- the tests. Each suite gets {page, R (Results), root, opts}.
import fs from 'fs';
import path from 'path';
import { Engine, readProject } from './lib.mjs';
import { viewer } from './viewer.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// time limits (ms): a fix shows within this time (also after a fatal error)
const FIX_MS = 1500;

function samePages(R, got, want, what) {
  const diff = Object.keys(want).filter(p => got[p] !== want[p]);
  const extra = Object.keys(got).filter(p => !(p in want));
  R.check(!diff.length && !extra.length,
    `${what}: pages differ (${diff.length ? 'changed ' + diff.join(',') : ''}${extra.length ? ' extra ' + extra.join(',') : ''})`);
}

// a text change of the basic project: [name, old, new, fatal?, expected error]
const A = 'MARK-A Here is \\textbf{bold text} and math $a^2+b^2=c^2$ inline.';
const ERROR_CASES = [
  ['open brace in \\textbf', A, A.replace('bold text}', 'bold text'), true, 'File ended while scanning use of \\textbf'],
  ['open brace in \\frac', A, A.replace('\\textbf{bold text}', '\\frac{1}{'), true, 'File ended while scanning use of \\frac'],
  ['open brace in a collected body', 'with \\textbf{bold} text.', 'with \\textbf{bold text.', true, 'File ended while scanning use of \\collect'],
  ['package name not complete', '\\usepackage{environ}', '\\usepackage{environ}\n\\usepackage{boo}', true, "File `boo.sty' not found"],
  ['open brace late in the document', 'Late text \\emph{here}', 'Late text \\emph{here', true, 'File ended while scanning use of \\emph'],
  ['open $', A, A.replace('c^2$', 'c^2'), false, 'Missing $ inserted'],
  ['undefined command', A, A.replace('\\textbf', '\\textbff'), false, 'Undefined control sequence'],
  ['extra }', A, A.replace('text}', 'text}}'), false, "Too many }'s"],
  ['half \\begin', A, A.replace('\\textbf{bold text}', '\\begin{itemi'), false, 'Paragraph ended before'],
  ['no \\end{itemize}', '  \\item two\n\\end{itemize}', '  \\item two\n', false, 'ended by \\end{document}'],
  ['\\end typo', '  \\item two\n\\end{itemize}', '  \\item two\n\\end{itemiz}', false, 'ended by \\end{itemiz}'],
  ['open brace in math', A, A.replace('$a^2', '$a^{2'), false, 'Missing } inserted'],
  ['TikZ path without ;', '\\draw (0,0) -- (2,1);', '\\draw (0,0) -- (2,1)', false, 'Did you forget a semicolon'],
  ['TikZ half coordinate', '\\draw (0,0) -- (2,1);', '\\draw (0,0) -- (2,;', false, 'tikz@parse'],
];

export const suites = {
  // Each error, then its fix: the engine must not restart, the error must
  // show, and the fix must give the same pages as before, fast.
  async errors({ page, R, root, opts }) {
    const files = readProject(path.join(root, 'test/projects/basic'));
    const base = files.get('main.tex').toString('utf8');
    const e = new Engine(page);
    await R.test('errors: start the basic project', async () => {
      await e.open(files);
      R.check(e.pageCount() >= 4, `page count ${e.pageCount()}`);
      R.check(!e.errors().length, `no errors at the start: ${e.errors()}`);
    });
    const start = await e.pages();
    for (const [name, old, neu, fatal, want] of ERROR_CASES) {
      if (opts.only && !name.includes(opts.only)) continue;
      await R.test(`errors: ${name}`, async () => {
        if (!R.check(base.includes(old), 'test text not found')) return;
        await e.edit('main.tex', base.replace(old, neu));
        await e.waitDone();
        await e.settle();
        R.check(!e.restarted(), 'the engine restarted on the error');
        R.check(e.errors().some(l => l.includes(want)), `error "${want}" not shown; errors: ${JSON.stringify(e.errors())}`);
        if (fatal) R.check(e.aborted(), 'fatal error expected (test case is wrong?)');
        await e.edit('main.tex', base);
        await e.waitDone();
        const ms = e.doneMs(), shown = e.fixMs(want);
        await e.settle();
        R.check(!e.restarted(), 'the engine restarted on the fix');
        R.check(shown !== null && shown < FIX_MS, `fix shown after ${shown} ms (limit ${FIX_MS})`);
        R.check(!e.errors().length, `errors after the fix: ${JSON.stringify(e.errors())}`);
        R.check(ms !== null && ms < FIX_MS, `fix took ${ms} ms (limit ${FIX_MS})`);
        samePages(R, await e.pages(), start, 'after the fix');
        R.note(`fix: shown after ${shown} ms, document done after ${ms} ms`);
      });
    }
    await e.close();
  },

  // Typing like a person (80 ms a key), with half commands on the way; then
  // random edits with braces and $; then the text of the start. No restart,
  // and the pages are the same as a fresh compile of the same text.
  async typing({ page, R, root }) {
    const files = readProject(path.join(root, 'test/projects/basic'));
    const base = files.get('main.tex').toString('utf8');
    const e = new Engine(page);
    await e.open(files);
    const start = await e.pages();
    const typed = '$\\frac{1}{2} + \\sqrt{x_{1}}$ and \\textbf{done}';
    const at = base.indexOf('Late text');
    let final = '';
    await R.test('typing: a formula, one key each 80 ms', async () => {
      for (let k = 1; k <= typed.length; k++) {
        final = base.slice(0, at) + typed.slice(0, k) + ' ' + base.slice(at);
        await e.edit('main.tex', final, { keepMark: k > 1 });
        await sleep(80);
      }
      await e.waitDone();
      await e.settle();
      R.check(!e.restarted(), 'the engine restarted while typing');
      R.check(!e.errors().length, `errors at the end: ${JSON.stringify(e.errors())}`);
    });
    await R.test('typing: same pages as a fresh compile', async () => {
      const got = await e.pages();
      await e.close();
      const f = new Engine(page);
      const files2 = new Map(files);
      files2.set('main.tex', Buffer.from(final));
      await f.open(files2);
      samePages(R, got, await f.pages(), 'live vs fresh');
      await f.close();
    });
    const g = new Engine(page);
    await g.open(files);
    await R.test('typing: 40 random edits with { } $ \\ (seed 7), then the start text', async () => {
      let seed = 7;
      const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      const lo = base.indexOf('\\begin{document}') + 17, hi = base.indexOf('\\end{document}');
      let text = base;
      g.mark();
      for (let k = 0; k < 40; k++) {
        const p = lo + rnd(hi - lo - 20);
        text = rnd(3) ? text.slice(0, p) + '{}$\\x'[rnd(5)] + text.slice(p) : text.slice(0, p) + text.slice(p + 1);
        await g.edit('main.tex', text, { keepMark: true });
        await sleep(60 + rnd(90));
      }
      await g.edit('main.tex', base, { keepMark: true });
      await g.waitDone();
      await g.settle();
      R.check(!g.restarted(), 'the engine restarted: ' + g.debugLog().filter(t => /failed|error/.test(t)).slice(0, 2).join(' | '));
      R.check(!g.errors().length, `errors at the end: ${JSON.stringify(g.errors())}`);
      samePages(R, await g.pages(), start, 'after the random edits');
    });
    await g.close();
  },

  // Click on characters of the page, then put the editor cursor where the
  // click went: the caret must come back to the same character. (A click
  // that goes to another place, or a caret somewhere else, makes the PDF jump.)
  async roundtrip({ page, R, root, opts }) {
    const dir = opts.project || path.join(root, 'test/projects/basic');
    const files = readProject(dir);
    const e = new Engine(page);
    await e.open(files, { main: opts.main || 'main.tex' });
    const pagesToTest = opts.pages || [0, 1];
    for (const p of pagesToTest) {
      await R.test(`roundtrip: page ${p + 1} of ${path.basename(dir)}`, async () => {
        const { map } = await e.pageMap(p);
        // a jump: the caret goes to another page (the PDF would scroll there).
        // Small faults (another character on the same line, a caret a few
        // points off) are counted and shown, but they do not fail the test.
        let tried = 0, wrongChar = 0, offset = 0, jumps = 0, noGoto = 0, notFollowed = 0, farCount = 0;
        const bad = [], footer = [];
        for (const l of map.lines) {
          const chars = [...l[4]], xs = l[5];
          for (let c = 0; c < chars.length; c += opts.step || 5) {
            if (!/[A-Za-z0-9]/.test(chars[c])) continue;
            tried++;
            const x = (xs[c] + xs[c + 1]) / 2, y = (l[1] + l[3]) / 2;
            const g = await e.click(p, x, y);
            if (g.type === 'debug') { notFollowed++; continue; }   // a click that would jump: not followed
            if (g.type !== 'goto') { noGoto++; continue; }
            const src = (e.texts.get(g.path) ?? readText(dir, g.path)).split('\n')[g.line - 1] || '';
            const okChar = src[g.column] === chars[c];
            const k = await e.cursor(g.path, g.line, g.column);
            const caret = k.type === 'caret';
            // (the page number: a known bug, counted apart)
            if (y > map.h - 160 && /^\d+$/.test(l[4].trim())) { footer.push(`"${l[4].trim()}" → ${g.path}:${g.line}:${g.column}, caret page ${k.page + 1}`); continue; }
            // far: on the same page, more than 30 pt up or down (code shown as a
            // listing and as its output: the caret is at the output; the viewer
            // does not scroll after a click, so this is no jump)
            const jump = !caret || k.page !== p;
            const far = !jump && Math.abs(k.y - y) > 30;
            if (far) farCount++;
            const off = !jump && !far && (Math.abs(k.x - xs[c]) > 1.5 || k.y < l[1] - 2 || k.y > l[3] + 6);
            if (!okChar) wrongChar++;
            if (jump) jumps++;
            if (off) offset++;
            if ((jump || far || !okChar || off) && bad.length < 12)
              bad.push(`${jump ? 'JUMP ' : far ? 'FAR ' : ''}"${chars[c]}" in "${l[4].slice(Math.max(0, c - 12), c + 12)}" (y ${y.toFixed(0)}) → ` +
                `${g.path}:${g.line}:${g.column} ("${src.slice(Math.max(0, g.column - 8), g.column)}|${src.slice(g.column, g.column + 8)}")` +
                (jump || far || off ? ` caret ${caret ? `p${k.page + 1} x ${k.x.toFixed(1)} y ${k.y.toFixed(1)} (want x ${xs[c].toFixed(1)})` : k.type}` : ''));
          }
        }
        R.note(`${tried} characters: ${jumps} jumps, ${wrongChar} to another source character, ${offset} with the caret off by some points, ${farCount} with the caret far away on the same page, ${notFollowed} not followed (would jump), ${noGoto} without an answer`);
        for (const b of bad) R.note('  ' + b);
        if (footer.length) R.note(`page number (known bug, not counted): ${footer.join('; ')}`);
        R.check(tried > 20, 'too few characters on the page');
        R.check(jumps === 0 && noGoto === 0, `${jumps + noGoto} clicks make the caret jump (or get no answer)`);
      });
    }
    await e.close();
  },

  // Silas' template (latex-templates main.tex): start, a fatal error in the
  // catalog and its fix (fast, no restart).
  async template({ page, R, opts }) {
    if (!opts.templates) { console.log('SKIP  template (no --templates folder)'); return; }
    const files = readProject(opts.templates);
    const e = new Engine(page);
    let start, base = [];
    // the last page is the compile-time table of the profile module: it is
    // different each run (not compared)
    const compare = (got, want) => {
      const last = String(Math.max(...Object.keys(want).map(Number)));
      const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== last));
      samePages(R, strip(got), strip(want), 'after the fix (last page not compared)');
    };
    await R.test('template: start latex-templates main.tex', async () => {
      await e.open(files);
      R.check(e.pageCount() >= 20, `page count ${e.pageCount()}`);
      base = e.errors();
      // (the test TeX Live is the local one, not TeX Live 2025 as Overleaf:
      // errors from that are shown, and the later tests compare with them)
      if (base.length) R.note(`errors at the start (test TeX Live): ${JSON.stringify(base.slice(0, 5))}`);
      start = await e.pages();
    });
    await R.test('template: open \\textbf in the catalog, then the fix', async () => {
      const guide = files.get('catalog/guide.tex').toString('utf8');
      await e.edit('catalog/guide.tex', guide.replace('Worked examples are', 'Worked \\textbf{examples are'));
      await e.waitDone();
      await e.settle();
      R.check(!e.restarted(), 'the engine restarted on the error');
      R.check(e.aborted(), 'fatal error expected');
      await e.edit('catalog/guide.tex', guide);
      await e.waitFor(m => m.type === 'page' || (m.type === 'errors' && !m.lines.some(l => l.includes('File ended'))), 20000, 'the fix');
      const ms = e.fixMs('File ended');
      await e.settle();
      R.check(!e.restarted(), 'the engine restarted on the fix');
      R.check(ms !== null && ms < FIX_MS, `fix shown after ${ms} ms (limit ${FIX_MS})`);
      R.check(JSON.stringify(e.errors()) === JSON.stringify(base), `errors after the fix: ${JSON.stringify(e.errors().slice(0, 5))}`);
      compare(await e.pages(), start);
      R.note(`fix shown after ${ms} ms`);
    });
    await e.close();
  },
};

// --- replay of a problem report (content.js: Report a problem) -------------
// Runs the engine part again: the project zip, the texts before the first
// kept edit, then each message to the engine at its time. Prints a timeline
// of the mouse and keys (from the report) and the engine's answers (in the
// report and now), so that a test can be written from it.
suites.replay = async function ({ page, R, opts }) {
  const rep = JSON.parse(fs.readFileSync(opts.replay, 'utf8'));
  const log = opts.quiet ? () => {} : console.log;
  if (rep.kind !== 'overleaf-live-report') throw new Error('not an Overleaf Live report');
  log(`report: version ${rep.version}, ${rep.time}, engine ${rep.engine}, note: ${rep.note || '-'}`);
  log(`state: ${JSON.stringify(rep.state).slice(0, 600)}`);
  const e = new Engine(page);
  const show = (m) => {
    const t = { ...m };
    for (const k of ['text', 'zip']) if (typeof t[k] === 'string' && t[k].length > 80) t[k] = t[k].slice(0, 40) + `…(${t[k].length})`;
    return JSON.stringify(t);
  };
  await R.test('replay: ' + path.basename(opts.replay), async () => {
    if (!R.check(rep.zip, 'the report has no project zip (Sync files once before the report)')) return;
    const view = rep.state.view || { first: 0, last: 3 };
    await e.openZip(rep.zip, { main: rep.main || 'main.tex', first: Math.max(0, view.first), last: Math.max(view.last, 0) });
    for (const [rel, text] of Object.entries(rep.base || {})) await e.edit(rel, text);
    if (Object.keys(rep.base || {}).length) { await e.waitDone(); await e.settle(); }
    const evs = rep.events;
    const t0 = evs.length ? evs[0].t : 0;
    const startAt = Date.now();
    e.mark();
    const skip = new Set(['hello', 'project', 'ping', 'lua']);
    for (const ev of evs) {
      const wait = (ev.t - t0) - (Date.now() - startAt);
      if (wait > 0) await sleep(Math.min(wait, 5000));
      const at = ((ev.t - t0) / 1000).toFixed(2).padStart(7);
      if (ev.dir === 'ui') log(`${at}  ui   ${JSON.stringify({ ...ev, t: undefined, dir: undefined })}`);
      else if (ev.dir === 'in') { if (!['page', 'count', 'debug'].includes(ev.msg.type)) log(`${at}  was  ${show(ev.msg)}`); }
      else if (!skip.has(ev.msg.type)) {
        log(`${at}  send ${show(ev.msg)}`);
        if (ev.msg.type === 'edit') await e.edit(ev.msg.path, ev.msg.text, { keepMark: true });
        else await e.send(ev.msg);
        await e.poll();
        for (const m of e.all.slice(e.shownUpTo ?? e.markAt).filter(m => !['page', 'count', 'debug'].includes(m.type)))
          log(`${at}  now  ${show(m)}`);
        e.shownUpTo = e.all.length;
      }
    }
    await e.settle();
    R.check(!e.restarted(), 'the engine restarted during the replay');
    R.note(`errors at the end: ${JSON.stringify(e.errors())}`);
  });
  await e.close();
};

suites.viewer = (a) => viewer({ ...a, suites });

function readText(dir, rel) {
  try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; }
}
