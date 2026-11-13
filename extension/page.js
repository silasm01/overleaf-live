// page.js -- runs in Overleaf's own page (not the extension's sandbox),
// because only there can it reach the editor. It adds a small CodeMirror
// extension through Overleaf's (unsupported) hook for browser extensions,
// and posts the text of the open file to content.js after every change,
// including changes made by collaborators.
(() => {
  const TAG = "__overleafLive";
  let docId = null;
  let view = null;
  let timer = null;

  const post = (msg) => window.postMessage({ [TAG]: true, ...msg }, location.origin);

  function sendText() {
    timer = null;
    if (view && docId) post({ kind: "doc", docId, text: view.state.doc.toString() });
  }

  // several changes in quick succession become one message
  function schedule() {
    if (!timer) timer = setTimeout(sendText, 40);
  }

  window.addEventListener("UNSTABLE_editor:extensions", (evt) => {
    const { CodeMirror, extensions } = evt.detail || {};
    if (!CodeMirror || !CodeMirror.ViewPlugin || !extensions) return;
    extensions.push(
      CodeMirror.ViewPlugin.define((v) => {
        view = v;
        schedule();
        return {
          update(u) {
            view = u.view;
            if (u.docChanged) schedule();
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
  });

  // content.js asks for the text again, e.g. after sending the project zip
  window.addEventListener("message", (evt) => {
    if (evt.source === window && evt.data && evt.data[TAG + "Cmd"] === "resend") sendText();
  });
})();
