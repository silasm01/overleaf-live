// viewer.mjs -- tests of the viewer (content.js) with the real extension in
// Chrome, on a fake Overleaf page (site/overleaf.html, served by serve.mjs).
// A copy of extension/ is loaded, with the test server added to the
// manifest (content script and host permission). The engine is the browser
// engine; its TeX Live comes from the test repository.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readProject, makeZip } from './lib.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PROJECT = '0123456789abcdef01234567';

function testExtension(root, cache, port) {
  const ext = path.join(cache, 'extension');
  fs.rmSync(ext, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'extension'), ext, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  // content.js (not page.js: the fake page does its part) on the fake Overleaf
  mf.content_scripts[1].matches.push(`http://127.0.0.1:${port}/project/*`);
  mf.host_permissions.push(`http://127.0.0.1:${port}/*`);
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));
  return ext;
}

export async function viewer({ page: enginePage, R, root, opts, server, port, chromium, suites }) {
  const cache = process.env.OLIVE_TEST_CACHE || path.join(os.homedir(), '.cache/olive-test');
  const ext = testExtension(root, cache, port);
  const ctx = await chromium.launchPersistentContext(path.join(cache, 'chrome-ext-profile'), {
    executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, acceptDownloads: true,
    viewport: { width: 1500, height: 950 },
    args: ['--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
           '--disable-features=DisableLoadExtensionCommandLineSwitch'] });
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    await sw.evaluate((u) => chrome.storage.local.set({ texRepos: [u], engine: 'browser' }), `http://127.0.0.1:${port}/tlnet`);
    const files = readProject(path.join(root, 'test/projects/basic'));
    server.state.zip = makeZip(files);
    const texts = Object.fromEntries([...files].filter(([k]) => k.endsWith('.tex')).map(([k, v]) => [k, v.toString('utf8')]));
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('fake overleaf page error:', e.message));
    page.on('crash', () => console.log('fake overleaf page: CRASH'));
    page.on('close', () => console.log('fake overleaf page: closed'));
    ctx.on('close', () => console.log('context closed'));
    await page.goto(`http://127.0.0.1:${port}/project/${PROJECT}`);
    await page.waitForSelector('.olive-toggle');
    await page.evaluate((f) => { fake.load(f); fake.openFile('main.tex'); }, texts);

    const statusText = () => page.evaluate(() => document.querySelector('.olive-toggle').textContent + ' | ' +
      (document.querySelector('.olive-menu-status') || {}).textContent);
    const scrollTop = () => page.evaluate(() => document.querySelector('.olive-scroll').scrollTop);
    const cmds = () => page.evaluate(() => fake.cmds.length);
    const newCmds = (from, kind) => page.evaluate(([f, k]) => fake.cmds.slice(f).filter(c => c.__overleafLiveCmd === k), [from, kind]);
    // a point in points on page p -> the mouse position in the window
    const at = (p, x, y) => page.evaluate(([p, x, y]) => {
      const slot = document.querySelectorAll('.olive-slot')[p];
      const r = slot.getBoundingClientRect();
      return { x: r.left + x / +slot.dataset.w * r.width, y: r.top + y / +slot.dataset.h * r.height };
    }, [p, x, y]);
    // scroll the viewer so that the point is in the middle (then wait)
    const show = async (p, x, y) => {
      const pt = await at(p, x, y);
      await page.evaluate((dy) => { const s = document.querySelector('.olive-scroll'); s.scrollTop += dy; },
        pt.y - await page.evaluate(() => { const r = document.querySelector('.olive-scroll').getBoundingClientRect(); return r.top + r.height / 2; }));
      await sleep(500);
      const q = await at(p, x, y);
      if (!(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.olive-slot'), [q.x, q.y])))
        throw new Error(`the point ${x},${y} of page ${p + 1} is not on the page in the window`);
      return q;
    };

    // click "Save report" in the open form: the report's text
    const saveReport = async () => {
      const n = await page.evaluate(() => fake.reports.length);
      await page.click('.olive-report-save');
      await page.waitForFunction((n) => fake.reports.length > n, n, { timeout: 10000 });
      return page.evaluate(() => fake.reports[fake.reports.length - 1].text);
    };
    // on a failure: the viewer's last events (from its problem report)
    const dumpEvents = async (n = 25) => {
      await page.keyboard.press('Alt+Shift+KeyR');
      const rep = JSON.parse(await saveReport());
      const skip = ['page', 'debug', 'pageCache', 'pageMap', 'probe', 'pageMaps', 'pageFields'];
      for (const e of rep.events.filter(e => !(e.msg && skip.includes(e.msg.type)) && e.ev !== 'drag').slice(-n))
        R.note(`  ${((e.t - rep.now) / 1000).toFixed(2)} ${e.dir} ${JSON.stringify(e.msg || { ...e, t: undefined, dir: undefined }).slice(0, 200)}`);
    };

    await R.test('viewer: Live on, pages come', async () => {
      await page.click('.olive-toggle');
      await page.waitForFunction(() => document.querySelectorAll('.olive-slot.olive-loaded').length >= 3, null, { timeout: 600000 });
      await sleep(3000);
      R.note('status: ' + await statusText());
    });

    await R.test('viewer: a drag that starts beside the text selects, and does not move the editor cursor', async () => {
      const a = await show(0, 60, 300), b = await at(0, 330, 330);
      const c0 = await cmds(), s0 = await scrollTop();
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      for (let k = 1; k <= 10; k++) await page.mouse.move(a.x + (b.x - a.x) * k / 10, a.y + (b.y - a.y) * k / 10);
      await page.mouse.up();
      await sleep(1500);
      const gotos = await newCmds(c0, 'goto');
      R.check(!gotos.length, `the drag moved the editor cursor (goto line ${gotos[0] && gotos[0].line})`);
      R.check(await page.evaluate(() => document.querySelectorAll('.olive-sel').length > 0), 'no text selected');
      R.check(Math.abs(await scrollTop() - s0) < 2, 'the PDF scrolled');
    });

    await R.test('viewer: a click on text moves the editor cursor there, and the PDF does not scroll', async () => {
      await page.mouse.click(10, 10);   // clear the selection
      const a = await show(0, 200, 300);
      const c0 = await cmds(), s0 = await scrollTop();
      await page.mouse.click(a.x, a.y);
      await sleep(1500);
      const gotos = await newCmds(c0, 'goto');
      R.check(gotos.length === 1, `${gotos.length} goto commands`);
      if (gotos[0]) R.check(gotos[0].line >= 7 && gotos[0].line <= 14, `goto line ${gotos[0].line} (want a paragraph of section 1)`);
      R.check(Math.abs(await scrollTop() - s0) < 2, 'the PDF scrolled');
    });

    await R.test('viewer: a click on the page number does not make the PDF jump', async () => {
      const a = await show(0, 303, 698);
      const c0 = await cmds(), s0 = await scrollTop();
      await page.mouse.click(a.x, a.y);
      await sleep(1500);
      const gotos = await newCmds(c0, 'goto');
      R.note(`goto: ${JSON.stringify(gotos.map(g => [g.line, g.column]))}`);
      R.check(Math.abs(await scrollTop() - s0) < 2, `the PDF scrolled by ${Math.round(await scrollTop() - s0)} px`);
      const caretPage = await page.evaluate(() => {
        const c = document.querySelector('.olive-caret');
        const slot = c && c.closest('.olive-slot');
        return slot ? [...document.querySelectorAll('.olive-slot')].indexOf(slot) : -1;
      });
      R.check(!gotos.length || caretPage === 0, `the caret went to page ${caretPage + 1}`);
    });

    await R.test('viewer: an open brace while typing: Live stays on, the pages stay', async () => {
      const text = texts['main.tex'];
      const bad = text.replace('Here is \\textbf{bold text}', 'Here is \\textbf{bold text');
      await page.evaluate((t) => fake.setText(t), bad);
      await sleep(2500);
      const st1 = await statusText();
      const n1 = await page.evaluate(() => document.querySelectorAll('.olive-slot.olive-loaded').length);
      await page.evaluate((t) => fake.setText(t), text);
      await sleep(1500);
      const pale = await page.evaluate(() => document.querySelectorAll('.olive-slot-stale').length);
      await sleep(3000);
      const st2 = await statusText();
      R.check(!/stopped/.test(st1 + st2), `status: ${st1} / ${st2}`);
      R.check(n1 >= 3, `${n1} pages shown during the error`);
      if (!R.check(!pale, `${pale} pages still pale 1.5 s after the fix`)) await dumpEvents(40);
      R.check(await page.evaluate(() => !document.querySelector('.olive-slot-stale')), 'pages still pale 4.5 s after the fix');
    });

    await R.test('viewer: Report a problem saves a report, and it replays', async () => {
      await page.focus('.olive-scroll');
      await page.keyboard.press('Alt+Shift+KeyR');
      await page.fill('.olive-report textarea', 'test report');
      const file = path.join(cache, 'last-test-report.json');
      fs.writeFileSync(file, await saveReport());
      const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
      R.check(rep.kind === 'overleaf-live-report' && rep.note === 'test report', 'not a report');
      R.check(rep.zip && rep.events.some(e => e.dir === 'ui' && e.ev === 'down') && rep.events.some(e => e.dir === 'out' && e.msg.type === 'edit'),
        'the report misses the zip, the mouse or the edits');
      R.note(`report: ${Math.round(fs.statSync(file).size / 1024)} KiB, ${rep.events.length} events`);
      opts.lastReport = file;
    });
  } finally {
    await ctx.close();
  }
  if (opts.lastReport) await suites.replay({ page: enginePage, R, opts: { ...opts, replay: opts.lastReport, quiet: true } });
}
