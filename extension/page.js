// page.js -- runs in Overleaf's own page (not the extension's sandbox),
// because only there can it reach the editor. It adds a small CodeMirror
// extension through Overleaf's (unsupported) hook for browser extensions,
// and posts to content.js:
//   - the text of the open file after every change, including changes
//     made by collaborators;
//   - the cursor position (for the caret in the live PDF);
//   - the .bbl file of Overleaf's last compile (for biblatex).
// content.js can ask it to move the cursor (reverse search), to select a
// range, and to replace a range (quick edit).
(() => {
  const TAG = "__overleafLive";
  let docId = null;
  let view = null;
  let CM = null;
  let timer = null;
  let cursorTimer = null;
  let lastCursor = "";

  const post = (msg) => window.postMessage({ [TAG]: true, ...msg }, location.origin);

  let lastSent = -1e9, firstChange = 0;
  function sendText() {
    timer = null;
    lastSent = performance.now();
    // t: when the first change of this message was made (latency, debug panel)
    if (view && docId) post({ kind: "doc", docId, text: engineDoc().toString(), t: firstChange || lastSent });
    firstChange = 0;
    // the cursor of the change, directly after its text (the messages keep
    // their order, so the engine searches the new text)
    if (cursorPending) { cursorPending = false; sendCursor(); }
  }

  // the first change goes at once; more changes in quick succession (40 ms)
  // become one message
  function schedule() {
    if (!firstChange) firstChange = performance.now();
    if (timer) return;
    const wait = 40 - (performance.now() - lastSent);
    if (wait <= 0) sendText();
    else timer = setTimeout(sendText, wait);
  }

  // line from 1, column from 0 (UTF-16 units, as CodeMirror)
  function sendCursor(force) {
    cursorTimer = null;
    if (!view || !docId) return;
    // (in the engine's text: without the collaborators' edits that are held)
    const pos = toEngine(view.state.selection.main.head);
    const line = engineDoc().lineAt(pos);
    const key = `${docId}:${line.number}:${pos - line.from}`;
    if (key === lastCursor && !force) { cursorAt = 0; return; }
    lastCursor = key;
    post({ kind: "cursor", docId, line: line.number, column: pos - line.from, t: cursorAt || performance.now() });
    cursorAt = 0;
  }

  // at once; while a text message waits (40 ms batch): directly after it
  let cursorAt = 0, cursorPending = false;
  function scheduleCursor() {
    if (!cursorAt) cursorAt = performance.now();
    clearTimeout(cursorTimer);
    if (timer) cursorPending = true;
    else sendCursor();
  }

  // --- collaborators' edits: held until they are stable ---
  // A change by another person (CodeMirror's Transaction.remote, which
  // Overleaf sets on changes from its server) does not go to the engine at
  // once: half-typed LaTeX from a collaborator would give errors (or no
  // pages) on this side. The engine has a copy of the text (shadow) without
  // the held changes (pending: shadow -> editor text); this user's own
  // changes go into the copy at once (moved over the held ones). The held
  // changes go to the engine when the collaborator has stopped for 2 s and
  // braces, \begin/\end and $ are as balanced as before; if they then give
  // a new error in their lines (content.js), they are held again.
  const HOLD_MS = 2000;
  let held = null;            // {shadow: Text, pending: ChangeSet, timer}
  let lastRelease = null;     // {shadow, pending, localSince} of the last release
  const engineDoc = () => held ? held.shadow : view.state.doc;
  const toEngine = (pos) => held ? held.pending.invertedDesc.mapPos(pos) : pos;
  const toEditor = (pos) => held ? held.pending.mapPos(pos) : pos;
  function isRemote(tr) {
    try { return tr.annotation(tr.constructor.remote) === true; } catch (e) { return false; }
  }
  function postHeld() {
    let n = 0, lines = [];
    if (held) held.pending.iterChangedRanges((fA, tA, fB, tB) => {
      n++;
      const doc = view.state.doc;
      lines.push([doc.lineAt(fB).number, doc.lineAt(Math.min(tB, doc.length)).number]);
    });
    post({ kind: "held", docId, n, lines });
  }
  function onTransactions(trs) {
    let remote = false;
    for (const tr of trs) {
      if (!tr.docChanged) continue;
      if (isRemote(tr)) {
        remote = true;
        if (!held) held = { shadow: tr.startState.doc, pending: tr.changes, timer: 0 };
        else held.pending = held.pending.compose(tr.changes);
        continue;
      }
      if (lastRelease) lastRelease.localSince = true;
      if (!held) continue;
      // an edit in the held text itself: no copy without it; all to the engine
      let overlap = false;
      held.pending.iterChangedRanges((fA, tA, fB, tB) => {
        tr.changes.iterChangedRanges((a, b) => { if (a <= tB && b >= fB) overlap = true; });
      });
      if (overlap) { dropHeld(); continue; }
      // this user's change, moved over the held ones, into the copy
      const inv = held.pending.invert(held.shadow);        // editor -> shadow
      const mine = tr.changes.map(inv);                    // on the shadow
      const invAfter = inv.map(tr.changes);                // new editor text -> new shadow
      held.shadow = mine.apply(held.shadow);
      held.pending = invAfter.invert(tr.state.doc);
    }
    if (remote) post({ kind: "remote" });
    if (remote && held) {
      clearTimeout(held.timer);
      held.timer = setTimeout(() => release(false), HOLD_MS);
      postHeld();
    }
  }
  function dropHeld() {
    if (!held) return;
    clearTimeout(held.timer);
    held = null;
    postHeld();
  }
  // braces, environments and $ of a text: as a key (the same before and
  // after a change: the change keeps them balanced)
  function balance(text) {
    let brace = 0, dollar = 0;
    const env = new Map();
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "%") { const e = text.indexOf("\n", i); if (e < 0) break; i = e; continue; }
      if (c === "\\") {
        const m = /^\\(begin|end)\s*\{([^}]*)\}/.exec(text.slice(i, i + 60));
        if (m) { env.set(m[2], (env.get(m[2]) || 0) + (m[1] === "begin" ? 1 : -1)); i += m[0].length - 1; }
        else i++;
        continue;
      }
      if (c === "{") brace++;
      else if (c === "}") brace--;
      else if (c === "$") dollar++;
    }
    return `${brace} ${dollar % 2} ` + [...env].filter(([, v]) => v).sort().map(([k, v]) => k + ":" + v).join(",");
  }
  function release(force) {
    if (!held || !view) return;
    if (!force && balance(view.state.doc.toString()) !== balance(held.shadow.toString())) {
      post({ kind: "held", docId, n: 1, unbalanced: true, lines: [] });
      return;           // the next remote change starts the wait again
    }
    const lines = [];
    held.pending.iterChangedRanges((fA, tA, fB, tB) => {
      const doc = view.state.doc;
      lines.push([doc.lineAt(fB).number, doc.lineAt(Math.min(tB, doc.length)).number]);
    });
    lastRelease = { shadow: held.shadow, pending: held.pending, localSince: false, at: performance.now() };
    clearTimeout(held.timer);
    held = null;
    post({ kind: "released", docId, lines, forced: !!force });
    postHeld();
    schedule();
    scheduleCursor();
  }
  // the released changes gave a new error: hold them again (if this user
  // did not edit since; later remote changes stay held with them)
  function rejectRelease() {
    const r = lastRelease;
    if (!r || r.localSince || !view) return;
    lastRelease = null;
    held = { shadow: r.shadow, pending: held ? r.pending.compose(held.pending) : r.pending, timer: 0 };
    postHeld();
    schedule();
    scheduleCursor();
  }

  window.addEventListener("UNSTABLE_editor:extensions", (evt) => {
    const { CodeMirror, extensions } = evt.detail || {};
    if (!CodeMirror || !CodeMirror.ViewPlugin || !extensions) return;
    CM = CodeMirror;
    extensions.push(
      CodeMirror.ViewPlugin.define((v) => {
        view = v;
        schedule();
        scheduleCursor();
        return {
          update(u) {
            view = u.view;
            if (u.docChanged && u.transactions) onTransactions(u.transactions);
            if (u.docChanged) schedule();
            if (u.docChanged || u.selectionSet) scheduleCursor();
          },
          destroy() {
            if (view === v) view = null;
          },
        };
      })
    );
  });

  // the file that was opened (Overleaf's id for it)
  window.addEventListener("doc:after-opened", (evt) => {
    docId = evt.detail && evt.detail.docId;
    if (held) { clearTimeout(held.timer); held = null; }
    lastRelease = null;
    post({ kind: "opened", docId });
    schedule();
    scheduleCursor();
  });

  // Overleaf's compile answer lists its output files. Its .bbl (made by Biber
  // or BibTeX on Overleaf) goes to content.js: the browser engine can't run
  // Biber, so for biblatex it uses Overleaf's .bbl. The file is fetched here,
  // in Overleaf's page, as Overleaf fetches its output files.
  const pageFetch = window.fetch;
  window.fetch = function (input, init) {
    const result = pageFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && /\/project\/[0-9a-f]{24}\/compile(\?|$)/.test(url)) {
        result.then((res) => res.clone().json()).then(async (data) => {
          const files = (data && Array.isArray(data.outputFiles)) ? data.outputFiles : [];
          const file = files.find((f) => /\.bbl$/.test(f.path || ""));
          if (!file || !file.url) return;
          const params = new URLSearchParams();
          if (data.compileGroup) params.set("compileGroup", data.compileGroup);
          if (data.clsiServerId) params.set("clsiserverid", data.clsiServerId);
          const query = params.toString() ? (file.url.includes("?") ? "&" : "?") + params : "";
          for (const u of [(data.pdfDownloadDomain || "") + file.url + query, file.url + query, file.url]) {
            try {
              const r = await pageFetch(u, { credentials: "include" });
              if (r.ok) { post({ kind: "bbl", text: await r.text() }); return; }
            } catch (e) { /* the next URL */ }
          }
        }).catch(() => {});
      }
    } catch (e) { /* never break Overleaf's own fetch */ }
    return result;
  };

  // line/column (line from 1) in the engine's text -> offset in the editor
  // (with held collaborators' edits, the two differ)
  function offsetOf(line, column) {
    const doc = engineDoc();
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    return toEditor(Math.min(l.from + Math.max(0, column), l.to));
  }

  // move the cursor to line/column and show it (reverse search); with
  // toLine/toColumn, select up to there (a quick-edit field)
  function gotoPosition(line, column, toLine, toColumn) {
    if (!view) return;
    const pos = offsetOf(line, column);
    const head = toLine ? offsetOf(toLine, toColumn) : pos;
    const spec = { selection: { anchor: pos, head } };
    if (CM && CM.EditorView && CM.EditorView.scrollIntoView)
      spec.effects = CM.EditorView.scrollIntoView(pos, { y: "center" });
    else
      spec.scrollIntoView = true;
    view.dispatch(spec);
    view.focus();
  }

  // the text of a line without its comment (an unescaped %)
  function uncommented(line) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") { i++; continue; }
      if (line[i] === "%") return line.slice(0, i);
    }
    return line;
  }

  // text: the block, with "$0" where the cursor goes; module: the name for
  // \usemodule (or "": none)
  function insertBlock(text, module) {
    const st = view.state, doc = st.doc, sel = st.selection.main;
    const changes = [];
    // on its own lines, never in the middle of a line: a selection is
    // replaced; on a line with text, the block goes after the line (before
    // it if the cursor is at its start)
    const line = doc.lineAt(sel.from);
    let from = sel.from, to = sel.to, before = "", after = "";
    if (sel.empty === false || sel.from !== sel.to) {
      const lineTo = doc.lineAt(sel.to);
      if (/\S/.test(doc.sliceString(line.from, sel.from))) before = "\n";
      if (/\S/.test(doc.sliceString(sel.to, lineTo.to))) after = "\n";
    } else if (/\S/.test(line.text)) {
      const lead = line.text.length - line.text.trimStart().length;
      if (sel.from - line.from <= lead) { from = to = line.from; after = "\n"; }
      else { from = to = line.to; before = "\n"; }
    }
    let block = before + text + after;
    let caret = block.indexOf("$0");
    block = block.replace("$0", "");
    if (caret < 0) caret = block.length;
    changes.push({ from, to, insert: block });
    // \usemodule
    let usemodule = "none";
    if (module) {
      let found = null, setup = null, begin = null;
      for (let n = 1; n <= doc.lines; n++) {
        const l = doc.line(n), t = uncommented(l.text);
        if (!found) {
          const m = /\\usemodule\s*\{([^}]*)\}/.exec(t);
          if (m) found = { line: l, m };
        }
        if (!setup && /\\input\s*\{\s*setup(\.tex)?\s*\}/.test(t)) setup = l;
        if (!begin && /\\begin\s*\{document\}/.test(t)) { begin = l; break; }
      }
      if (found) {
        const names = found.m[1].split(",").map((x) => x.trim()).filter(Boolean);
        if (names.includes(module)) usemodule = "loaded";
        else {
          // before the closing brace of \usemodule{...}
          const close = found.line.from + found.m.index + found.m[0].length - 1;
          changes.push({ from: close, to: close, insert: (names.length ? ", " : "") + module });
          usemodule = "added";
        }
      } else if (setup) {
        changes.push({ from: setup.to, to: setup.to, insert: `\n\\usemodule{${module}}` });
        usemodule = "added";
      } else if (begin) {
        changes.push({ from: begin.from, to: begin.from, insert: `\\usemodule{${module}}\n` });
        usemodule = "added";
      } else usemodule = "elsewhere";      // not the main file
    }
    // the cursor: in the block, after the changes (a \usemodule edit is
    // before the block, in the preamble)
    changes.sort((a, b) => a.from - b.from);
    let shift = 0;
    for (const c of changes) if (c.from < from) shift += c.insert.length - (c.to - c.from);
    view.dispatch({ changes, selection: { anchor: from + shift + caret }, scrollIntoView: true });
    view.focus();
    return { ok: true, usemodule };
  }

  window.addEventListener("message", (evt) => {
    if (evt.source !== window || !evt.data) return;
    const cmd = evt.data[TAG + "Cmd"];
    // content.js asks for the text again, e.g. after sending the project zip
    if (cmd === "resend") {
      sendText();
      sendCursor(true);
    }
    // Ctrl+Z / Ctrl+Shift+Z in the live viewer: the editor's undo / redo
    // (as the key in the editor: CodeMirror's history, e.g. of a quick edit)
    if ((cmd === "undo" || cmd === "redo") && view) {
      const mac = /Mac/.test(navigator.platform);
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", code: "KeyZ", ctrlKey: !mac, metaKey: mac, shiftKey: cmd === "redo",
        bubbles: true, cancelable: true }));
    }
    if (cmd === "releaseHeld") release(true);
    if (cmd === "rejectRelease" && evt.data.docId === docId) rejectRelease();
    if (cmd === "goto" && evt.data.docId === docId)
      gotoPosition(evt.data.line, evt.data.column, evt.data.toLine, evt.data.toColumn);
    // insert a blank module at the cursor (on its own lines), and load the
    // module with \usemodule if this file does not load it yet
    if (cmd === "insert" && view) {
      const d = evt.data;
      const r = insertBlock(String(d.text || ""), String(d.module || ""));
      post({ kind: "inserted", ...r, module: d.module });
    }
    // quick edit: replace a field, if it still has the text it had
    if (cmd === "replace") {
      const d = evt.data;
      let ok = false, why = "the file is not open in the editor";
      if (view && d.docId === docId && Array.isArray(d.edits)) {
        // several edits at once (a K-map cell: \minterms and \dontcares),
        // all or none; positions are in the text before the edits
        const ch = d.edits.map(e => ({ from: offsetOf(e.line, e.column), to: offsetOf(e.toLine, e.toColumn),
                                       insert: e.text, expect: e.expect }))
                          .sort((a, b) => a.from - b.from);
        if (ch.some(c => view.state.doc.sliceString(c.from, c.to) !== c.expect)) why = "the text changed";
        else if (ch.some((c, i) => i > 0 && c.from < ch[i - 1].to)) why = "the edits overlap";
        else {
          view.dispatch({ changes: ch.map(({ from, to, insert }) => ({ from, to, insert })) });
          ok = true;
        }
      } else if (view && d.docId === docId) {
        const from = offsetOf(d.line, d.column), to = offsetOf(d.toLine, d.toColumn);
        if (view.state.doc.sliceString(from, to) !== d.expect) why = "the text changed";
        else {
          view.dispatch({ changes: { from, to, insert: d.text },
                          selection: { anchor: from, head: from + d.text.length } });
          ok = true;
        }
      }
      post({ kind: "replaced", ok, why, id: d.id });
    }
  });
})();
