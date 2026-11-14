// Loads a copy of the extension (with test.html/test.js/proj.zip and host permission for
// http://127.0.0.1:8790/*) in headless Chrome, uses the test repository of make-fake-tlnet.py,
// waits for 3 pages, makes 2 edits and writes the pages to /tmp/ext-pages. Paths are for the test VM.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const ext = '/tmp/ext4';
if (!process.env.KEEP) fs.rmSync('/tmp/ext-profile5', { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext('/tmp/ext-profile5', { executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--disable-features=DisableLoadExtensionCommandLineSwitch'] });
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
await sw.evaluate(() => chrome.storage.local.set({ texRepos: ['http://127.0.0.1:8790/tlnet'] }));
const page = await ctx.newPage();
page.on('console', m => console.log('page console:', m.text()));
await page.goto(`chrome-extension://${id}/test.html`);
const guide = fs.readFileSync('/home/claude/latex-templates/catalog/guide.tex', 'utf8');
const waitPages = async (label, n, timeout = 120000) => {
  const s = Date.now();
  while (Date.now() - s < timeout) {
    const r = await page.evaluate(() => window.result());
    if (r.pageTimes.filter(p => p.phase === label).length >= n) return;
    await new Promise(r => setTimeout(r, 100));
  }
};
await waitPages('start', 3, 600000);
await new Promise(r => setTimeout(r, 3000));
const e1 = guide.replace('Worked examples are', 'Worked examples (EDITED NOW) are');
await page.evaluate(([t]) => window.sendEdit('catalog/guide.tex', t, 'edit1'), [e1]);
await waitPages('edit1', 1, 60000);
await new Promise(r => setTimeout(r, 2000));
const e2 = e1.replace('holds only what', 'holds only and exactly what');
await page.evaluate(([t]) => window.sendEdit('catalog/guide.tex', t, 'edit2'), [e2]);
await waitPages('edit2', 1, 60000);
await new Promise(r => setTimeout(r, 1000));
const r = await page.evaluate(() => window.result());
fs.mkdirSync('/tmp/ext-pages', { recursive: true });
for (const [p, d] of Object.entries(r.images)) fs.writeFileSync(`/tmp/ext-pages/page-${p}.png`, Buffer.from(d, 'base64'));
console.log(r.log.join('\n'));
console.log(JSON.stringify(r.pageTimes));
await ctx.close();
