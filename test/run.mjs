// run.mjs -- runs the tests (see test/README.md). Exit code 1 if one fails.
//   node test/run.mjs [suite ...] [--only <text in a test name>] [--project <folder> --pages 1,2] [--templates <latex-templates folder>] [--replay <report.json>]
// Env: TLNET (test TeX Live repository), PLAYWRIGHT (playwright/index.mjs),
//      CHROME (Chrome binary), TEST_PROFILE (Chrome profile: keeps the
//      engine's TeX Live store and format between runs).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { serve } from './serve.mjs';
import { Results } from './lib.mjs';
import { suites } from './suites.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opts = {};
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--templates') opts.templates = path.resolve(args[++i]);
  else if (args[i] === '--only') opts.only = args[++i];
  else if (args[i] === '--project') opts.project = path.resolve(args[++i]);
  else if (args[i] === '--pages') opts.pages = args[++i].split(',').map(n => +n - 1);
  else if (args[i] === '--replay') opts.replay = path.resolve(args[++i]);
  else names.push(args[i]);
}
const run = names.length ? names : ['errors', 'typing', 'roundtrip', 'viewer', 'template'];
if (opts.replay && !names.length) run.splice(0, run.length, 'replay');
for (const n of run) if (!suites[n]) { console.error(`no suite "${n}" (${Object.keys(suites).join(', ')})`); process.exit(2); }

const { chromium } = await import(process.env.PLAYWRIGHT);
const server = await serve({ root, tlnet: process.env.TLNET });
const port = server.address().port;
const ctx = await chromium.launchPersistentContext(process.env.TEST_PROFILE, {
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => console.log('page error:', e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
// the store of the engine belongs to the origin: the same port each run
const R = new Results();
const t0 = Date.now();
for (const n of run) await suites[n]({ page, R, root, opts, server, port, chromium });
await ctx.close();
server.close();
const failed = R.list.filter(r => !r.ok);
const known = R.list.filter(r => r.known);
for (const k of known) console.log('  KNOWN ' + k.name);
console.log(`\n${R.list.length - failed.length - known.length} passed, ${known.length} known bugs, ${failed.length} failed (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
for (const f of failed) console.log('  FAIL ' + f.name);
process.exit(failed.length ? 1 : 0);
