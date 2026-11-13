// page.js -- runs in Overleaf's own page (not the extension's sandbox),
// because only there can it reach the editor. It adds a small CodeMirror
// extension through Overleaf's (unsupported) hook for browser extensions,
// and posts to content.js:
//   - the text of the open file after every change, including changes
//     made by collaborators;
//   - the cursor position (for the caret in the live PDF).
// content.js can ask it to move the cursor (reverse search).
(() => {
  const TAG = "__overleafLive";
  let docId = null;
  let view = null;
  let CM = null;
  let timer = null;
  let cursorTimer = null;
  let lastCursor = "";

  const post = (msg) => window.postMessage({ [TAG]: true, ...msg }, location.origin);

  function sendText() {
    timer = null;
    if (view && docId) post({ kind: "doc", docId, text: view.state.doc.toString() });
  }

  // several changes in quick succession become one message
  function schedule() {
    if (!timer) timer = setTimeout(sendText, 40);
  }

  // line from 1, column from 0 (UTF-16 units, as CodeMirror)
  function sendCursor(force) {
    cursorTimer = null;
    if (!view || !docId) return;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const key = `${docId}:${line.number}:${pos - line.from}`;
    if (key === lastCursor && !force) return;
    lastCursor = key;
    post({ kind: "cursor", docId, line: line.number, column: pos - line.from });
  }

  // after the text (40 ms), so that TeXpresso searches the new text
  function scheduleCursor() {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(sendCursor, 90);
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
    post({ kind: "opened", docId });
    schedule();
    scheduleCursor();
  });

  // move the cursor to line/column and show it (reverse search)
  function gotoPosition(line, column) {
    if (!view) return;
    const doc = view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(l.from + Math.max(0, column), l.to);
    const spec = { selection: { anchor: pos } };
    if (CM && CM.EditorView && CM.EditorView.scrollIntoView)
      spec.effects = CM.EditorView.scrollIntoView(pos, { y: "center" });
    else
      spec.scrollIntoView = true;
    view.dispatch(spec);
    view.focus();
  }

  window.addEventListener("message", (evt) => {
    if (evt.source !== window || !evt.data) return;
    const cmd = evt.data[TAG + "Cmd"];
    // content.js asks for the text again, e.g. after sending the project zip
    if (cmd === "resend") {
      sendText();
      sendCursor(true);
    }
    if (cmd === "goto" && evt.data.docId === docId) gotoPosition(evt.data.line, evt.data.column);
  });
})();
