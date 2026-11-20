# Tests

The tests run the real browser engine (`extension/engine/`) and the real viewer
(`extension/content.js`) in headless Chrome. There is no Overleaf login: a fake
Overleaf page (`site/overleaf.html`) does the part of Overleaf and `page.js`.

## Run

```
test/run.sh                                   # all suites (approx. 6 minutes)
test/run.sh errors typing                     # some suites
test/run.sh errors --only "\\frac"            # only the tests whose name has this text
test/run.sh --templates ../latex-templates    # also the latex-templates suite
test/run.sh roundtrip --project ../latex-templates --pages 2,5   # clicks on other pages
test/run.sh --replay overleaf-live-report-20261120-171500.json  # a problem report
```

Needs node, Google Chrome, playwright (`npm -g`), python3 and a TeX Live. The
first run makes a test TeX Live repository from the local TeX Live (approx. 1
minute) in `~/.cache/olive-test`. The engine's TeX Live store and format stay
in a Chrome profile there, so later runs start faster.

The exit code is 1 if a test fails. **Rule: all tests pass before a new
version is published** (update.sh, Chrome Web Store).

## Suites

| Suite | What it tests |
|---|---|
| `errors` | 14 typing errors (5 fatal, 9 recoverable), each then its fix: no engine restart, the error shows, the fix comes within 1.5 s, the pages are the same as before |
| `typing` | a formula typed one key at a time (80 ms), then 40 random edits with `{ } $ \`: no restart; live pages = a fresh compile |
| `roundtrip` | a click on characters of a page, then the editor cursor at the place the click went: the caret must stay on the same page and line (no jump). Shows small faults too |
| `viewer` | the extension on the fake Overleaf: drag to select, click, page number, an open brace while typing, Report a problem (and its replay) |
| `template` | latex-templates `main.tex` (with `--templates`): start without errors, a fatal error in the catalog and its fix |
| `replay` | a problem report (with `--replay`) |

A test can be marked `known` (a known bug that is not fixed yet): it shows as
`KNOWN` and does not fail the run. When it passes, the output says so: then
remove `known`.

## Problem reports

In the Live menu, **Report a problem** (or **Alt+Shift+R** in the Overleaf tab)
opens a small form. **Save report** downloads
`overleaf-live-report-<date>-<time>.json`. It has:

- the last minute: the messages to and from the engine (edits with their full
  text; pictures without their pixels), the mouse and keys on the live pages,
  scrolling;
- the state of the viewer (status, errors, page count, view, caret, zoom);
- the pictures of the pages in view, and the project zip of the last sync.

So the file has the text of the project. Send it only to people who may see
the project.

`test/run.sh --replay <file>` opens the project of the report in the test
engine, gives it the same messages at the same times, and prints a timeline:
`ui` (mouse and keys), `send` (to the engine), `was` (the answer in the report)
and `now` (the answer now). From this, write a test that fails, then fix the bug.

## Workflow for a bug

1. Silas saves a problem report and sends it (in the chat).
2. Replay it, and find the cause.
3. Write a test that fails because of the bug (in `suites.mjs` or `viewer.mjs`).
4. Fix the bug. The new test and all old tests pass.
5. Publish only when `test/run.sh --templates ../latex-templates` passes.

## Files

- `run.sh`, `run.mjs`: start the server and Chrome, run the suites.
- `serve.mjs`: the test server (engine, test TeX Live, fake Overleaf, its zip).
- `lib.mjs`: `Engine` (drives `worker.js` as content.js does), zip, results.
- `suites.mjs`: errors, typing, roundtrip, template, replay.
- `viewer.mjs`: the viewer tests with the extension (a copy with the test
  server in its manifest is made in `~/.cache/olive-test/extension`).
- `site/index.html`: the page that starts engine workers.
- `site/overleaf.html`: the fake Overleaf page.
- `projects/basic/`: the test project.
