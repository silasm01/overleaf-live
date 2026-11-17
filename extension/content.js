// content.js -- the extension's part of the Overleaf page: the live viewer
// over Overleaf's PDF pane, driven by Overleaf's own PDF toolbar (page,
// zoom, theme); the Live button with its status and menu; the project
// upload and the edits from page.js, all sent to the local helper through
// background.js. Also runs in Overleaf's "PDF in separate tab"
// (/project/<id>/detached): that tab shows the pages, the editor tab sends
// the edits.
// SyncTeX: the editor cursor is shown as a caret on the live page (the PDF
// scrolls only when the caret is out of view); a double-click on a live
// page moves the editor cursor there.
(() => {
  const TAG = "__overleafLive";
  const match = location.pathname.match(/^\/project\/([0-9a-f]{24})(\/detached)?/);
  if (!match) return;
  const projectId = match[1];
  const detached = !!match[2];
  const PT = 4 / 3;              // CSS pixels per PDF point at 100% (as pdf.js)

  const settingsKey = "project:" + projectId;
  let settings = { on: false, lua: false, main: "", zoom: { mode: "page-width", scale: 1 } };
  let port = null;
  let connected = false;
  let lastText = new Map();      // path -> text last sent
  let pageCount = 0;             // pages typeset so far
  let done = false;              // true: the document is finished, pageCount is all
  let knownTotal = 0;            // pages when the document was last finished
  let pageSize = { w: 595.28, h: 841.89 };   // points, from the first page
  let lastSync = 0;
  let syncTimer = null;
  let widthTimer = null;
  let view = { first: -1, last: -1 };        // visible pages last sent
  let status = { text: "not connected", busy: false };
  let errors = [];
  let caret = null;              // {page, x, y, h, d} in points, from the helper
  let lastCursorMove = 0;        // when the editor cursor last moved
  let caretTimer = null;
  let cursorSeq = 0;             // cursor messages sent (the engine's caret answers name theirs)
  let lastCursor = null;         // {path, line, column}: the editor cursor last sent
  let pendingGoto = null;        // reverse search waiting for a file to open
  let afterOpen = null;          // { path, run }: to do when that file is open (quick edit)
  let pendingField = null;       // quick edit: the field of the last double-click
  let scanPage = -1;             // the page of the last double-click
  let docId = null;              // the file open in the editor (Overleaf's id)
  let engine = "browser";        // "browser" (WebAssembly) or "wsl" (the helper); for all projects

  // --- the viewer and the Live button ---------------------------------
  const ui = document.createElement("div");
  ui.className = "olive-root";
  ui.innerHTML = `
    <div class="olive-pane" hidden>
      <div class="olive-scroll" tabindex="0"><div class="olive-pages"></div></div>
      <button class="olive-insert-btn" title="Insert a blank module at the editor cursor">+ Insert</button>
      <div class="olive-modbar" hidden></div>
      <div class="olive-modform" hidden></div>
      <div class="olive-insert-menu" hidden></div>
      <div class="olive-progress"></div>
      <div class="olive-errors" hidden></div>
    </div>
    <div class="olive-pill">
      <div class="olive-menu" hidden>
        <div class="olive-menu-status"></div>
        <pre class="olive-menu-errors" hidden></pre>
        <label class="olive-menu-engine" title="In the browser: TeXpresso runs as WebAssembly in Chrome, nothing to install. WSL helper: TeXpresso runs in WSL on your PC (start the helper there).">
          Engine <select class="olive-engine">
            <option value="browser">In the browser</option>
            <option value="wsl">WSL helper</option>
          </select></label>
        <label class="olive-menu-lua" title="WSL helper: runs a normal XeLaTeX compile with shell escape on your PC for calc/fsm results. Shell escape can run any command: turn on only for projects you trust. In the browser engine, Lua results are always on (a Lua sandbox, no shell).">
          <input type="checkbox" class="olive-lua"> Lua results (shell escape)</label>
        <div class="olive-menu-buttons">
          <button class="olive-sync" title="Send all project files again">Sync files</button>
          <button class="olive-off">Turn off Live</button>
        </div>
      </div>
      <button class="olive-toggle" title="Live preview by TeXpresso on your PC">
        <span class="olive-dot"></span><span class="olive-label">Live</span></button>
    </div>`;
  const $ = (sel) => ui.querySelector(sel);
  const pane = $(".olive-pane"), scroller = $(".olive-scroll"), pages = $(".olive-pages");
  const menu = $(".olive-menu");

  function active() {
    return settings.on && ui.isConnected && !pane.hidden;
  }

  // the Live button: a dot and a short status while Live is on
  function showStatus() {
    const toggle = $(".olive-toggle");
    let label = "Live", state = "off";
    if (settings.on) {
      if (!connected) { state = "down"; label = "Live · not connected"; }
      else if (errors.length) { state = "error"; label = `Live · ${errors.length} error${errors.length > 1 ? "s" : ""}`; }
      else if (status.busy) { state = "busy"; label = `Live · ${status.text}`; }
      else { state = "ok"; label = "Live"; }
    }
    $(".olive-label").textContent = label;
    toggle.dataset.state = state;
    toggle.title = settings.on ? status.text : "Live preview by TeXpresso on your PC";
    $(".olive-menu-status").textContent = connected ? status.text
      : engine === "wsl" ? "Helper not running (start it in WSL)." : "Engine not running.";
    $(".olive-engine").value = engine;
    // the browser engine runs Lua live in a sandbox: always on
    $(".olive-lua").disabled = engine !== "wsl";
    $(".olive-lua").checked = engine === "wsl" ? settings.lua : true;
    const box = $(".olive-menu-errors");
    box.hidden = !errors.length;
    box.textContent = errors.map((l) => "! " + l).join("\n");
  }

  function setStatus(text, busy) {
    status = { text, busy: !!busy };
    showStatus();
    showProgress();
  }

  // --- progress and errors in the viewer ----------------------------------
  // A thin bar at the top while the engine works (after an edit until the
  // pages in view are new, or while the status says busy); a short green
  // bar when it is done without errors.
  let working = false, workTimer = null;
  function showProgress() {
    const bar = $(".olive-progress");
    const on = settings.on && connected && (working || status.busy);
    if (on) { bar.className = "olive-progress olive-progress-on"; return; }
    if (bar.classList.contains("olive-progress-on")) {
      bar.className = "olive-progress" + (errors.length ? "" : " olive-progress-done");
      setTimeout(() => bar.classList.remove("olive-progress-done"), 700);
    }
  }
  function startWork() {
    working = true;
    clearTimeout(workTimer);
    workTimer = setTimeout(endWork, 4000);    // no new page: nothing changed in view
    showProgress();
  }
  function endWork() {
    clearTimeout(workTimer);
    if (!working) editAt = 0;
    if (!working) return;
    working = false;
    showProgress();
  }

  // the errors: a list at the top of the viewer; a click goes to the line
  function showErrors(items) {
    const box = $(".olive-errors");
    box.textContent = "";
    box.hidden = !settings.on || !items.length;
    if (box.hidden) return;
    const head = document.createElement("div");
    head.className = "olive-errors-head";
    head.textContent = `${items.length} error${items.length > 1 ? "s" : ""}`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = box.classList.contains("olive-errors-folded") ? "show" : "hide";
    toggle.addEventListener("click", () => {
      box.classList.toggle("olive-errors-folded");
      toggle.textContent = box.classList.contains("olive-errors-folded") ? "show" : "hide";
    });
    head.appendChild(toggle);
    box.appendChild(head);
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "olive-error";
      const where = it.file ? `${it.file}${it.line ? ":" + it.line : ""}` : it.line ? `line ${it.line}` : "";
      row.textContent = (where ? where + "  " : "") + it.text;
      if (it.file && it.line) {
        row.classList.add("olive-error-link");
        row.title = "Go to the line";
        row.addEventListener("click", () => gotoSource({ path: it.file, line: it.line, column: 0 }));
      }
      box.appendChild(row);
    }
  }

  $(".olive-toggle").addEventListener("click", () => {
    if (!settings.on) setOn(true);
    else menu.hidden = !menu.hidden;
  });
  $(".olive-off").addEventListener("click", () => { menu.hidden = true; setOn(false); });
  $(".olive-sync").addEventListener("click", () => sync(true));

  // --- insert a blank module at the editor cursor ---
  // "$0": where the cursor goes; module: the name for \usemodule
  const BLANKS = [
    ["Karnaugh map", [
      ["3 variables", "kmap", String.raw`\begin{kmap}{x, y, z}
  \minterms{$0}
  \autoterms[0]
\end{kmap}`],
      ["4 variables", "kmap", String.raw`\begin{kmap}{w, x, y, z}
  \minterms{$0}
  \autoterms[0]
\end{kmap}`]]],
    ["Truth table", [
      ["2 inputs", "truthtable", String.raw`\begin{truthtable}{x, y}{f}
  0 & 0 & $0 \\
  0 & 1 &  \\
  1 & 0 &  \\
  1 & 1 &  \\
\end{truthtable}`],
      ["3 inputs", "truthtable", String.raw`\begin{truthtable}{x, y, z}{f}
  0 & 0 & 0 & $0 \\
  0 & 0 & 1 &  \\
  0 & 1 & 0 &  \\
  0 & 1 & 1 &  \\
  1 & 0 & 0 &  \\
  1 & 0 & 1 &  \\
  1 & 1 & 0 &  \\
  1 & 1 & 1 &  \\
\end{truthtable}`]]],
    ["State machine", [
      ["Moore", "fsm", String.raw`\begin{fsm}[moore]{i}{z}
  \state{A}[0]{0}{0: A, 1: A}$0
\end{fsm}
\fsmdiagram \qquad \fsmtable`],
      ["Mealy", "fsm", String.raw`\begin{fsm}[mealy]{i}{z}
  \state{A}{0: A/0, 1: A/0}$0
\end{fsm}
\fsmdiagram \qquad \fsmtable`]]],
    ["Circuit", [
      ["Electric circuit", "circuit", String.raw`\begin{circuit}
  \at{a(0,2) b(3,2) c(0,0) d(3,0)}
  \comp{a}{b}{R}$0
\end{circuit}`],
      ["Logic gates", "circuit", String.raw`\begin{circuit}
  \gate{and}{G}{a, b}$0
  \outputs{G=f}
\end{circuit}`]]],
    ["Math", [
      ["Complex plane", "cplane", String.raw`\begin{cplane}
  $0
\end{cplane}`],
      ["Calculation with units", "calc", String.raw`\setvar{$0R}{1\kilo\ohm}
\calc{U = R*1\milli\ampere}`]]],
    ["Other", [
      ["Code listing", "code", String.raw`\begin{lstlisting}[language=Python]
$0
\end{lstlisting}`],
      ["Responsibility table", "responsibility", String.raw`\begin{responsibility}{2}{Name A & Name B}
  1 & $0 &  \\
\end{responsibility}`],
      ["Figures side by side", "sidebyside", String.raw`\begin{figure}[H]
  \begin{sidebyside}
    \panel{\includegraphics{example-image-a}}[Left]
    \divider
    \panel{\includegraphics{example-image-b}}[Right]
  \end{sidebyside}
  \caption{$0}
\end{figure}`]]]];
  {
    const btn = $(".olive-insert-btn"), menu = $(".olive-insert-menu");
    if (detached) btn.remove();     // the editor is in the other tab
    for (const [group, items] of BLANKS) {
      const h = document.createElement("div");
      h.className = "olive-insert-group";
      h.textContent = group;
      menu.appendChild(h);
      for (const [label, module, text] of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => {
          menu.hidden = true;
          window.postMessage({ [TAG + "Cmd"]: "insert", text, module }, location.origin);
        });
        menu.appendChild(b);
      }
    }
    btn.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener("mousedown", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
    }, true);
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; });
  }
  $(".olive-engine").addEventListener("change", (e) => {
    engine = e.target.value === "wsl" ? "wsl" : "browser";
    chrome.storage.local.set({ engine });     // storage.onChanged reconnects (all tabs)
  });
  $(".olive-lua").addEventListener("change", (e) => {
    settings.lua = e.target.checked;
    save();
    send({ type: "lua", on: settings.lua });
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !ui.querySelector(".olive-pill").contains(e.target)) menu.hidden = true;
  }, true);

  // --- pages ------------------------------------------------------------
  // One slot per page, one under the other as in Overleaf. While the
  // document isn't finished, one more empty slot: when it comes into view,
  // TeXpresso typesets the next page.
  function slots() { return pages.children; }

  function newSlot() {
    const slot = document.createElement("div");
    slot.className = "olive-slot";
    slot.appendChild(document.createElement("img"));
    return slot;
  }

  // a new picture of a page: shown when it is decoded (no blank frame);
  // a newer picture wins over an older one that decodes later
  function showImage(slot, src) {
    const gen = (+slot.dataset.gen || 0) + 1;
    slot.dataset.gen = gen;
    const img = new Image();
    img.src = src;
    img.decode().catch(() => {}).then(() => {
      if (+slot.dataset.gen !== gen) return;
      const old = slot.querySelector("img");
      if (old) slot.replaceChild(img, old);
      else slot.prepend(img);
      // latency: from the key press to the new picture on the screen
      if (editAt) { latency("key → picture", performance.now() - editAt); editAt = 0; }
      // the new picture shows the change: the instant values go
      for (const el of slot.querySelectorAll(".olive-instant")) el.remove();
    });
  }

  // Instant feedback (a test option of the debug panel, off by default):
  // a double-click outlines what it edits at once (from the hover cache),
  // and a value chosen in a menu shows on the page at once, until the new
  // picture comes (at most 4 s)
  const instantOn = () => { try { return dbg.instant; } catch (e) { return false; } };
  function instantValue(slot, box, text) {
    if (!instantOn() || !slot || box[2] - box[0] > 60 || box[3] - box[1] > 25) return;
    for (const el of slot.querySelectorAll(".olive-instant")) if (el.dataset.box === box.join()) el.remove();
    const el = document.createElement("div");
    el.className = "olive-instant";
    el.dataset.box = box.join();
    el.textContent = text;
    el.style.fontStyle = /^[A-Za-z]+$/.test(text) ? "italic" : "normal";   // (math: letters italic)
    placeBox(el, slot, box);
    const zoom = slot.getBoundingClientRect().width / (+slot.dataset.w || pageSize.w);
    el.style.fontSize = Math.max(6, (box[3] - box[1]) * 0.7 * zoom) + "px";
    slot.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
  function instantOutline(pt) {
    if (!instantOn() || !pt) return;
    const ed = editableAt(pt);
    if (!ed) return;
    const el = document.createElement("div");
    el.className = "olive-hover-box olive-instant-outline";
    placeBox(el, pt.slot, ed.box);
    pt.slot.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  // latencies for the debug panel (what the user waits for)
  let editAt = 0, scanAt = 0, cursorAt = 0, cursorCached = false;
  function latency(what, ms, extra) {
    try { dbg.timing({ kind: "latency", what, ms: Math.round(ms), extra }); } catch (e) { /* not set up yet */ }
  }

  // a change of sizes keeps the page in view where it is
  function keepScroll(fn) {
    const box = scroller.getBoundingClientRect();
    let anchor = null, top = 0;
    for (const s of slots()) {
      const r = s.getBoundingClientRect();
      if (r.bottom > box.top) { anchor = s; top = r.top; break; }
    }
    fn();
    if (anchor && anchor.isConnected) {
      const d = anchor.getBoundingClientRect().top - top;
      if (Math.abs(d) > 0.5) scroller.scrollTop += d;
    }
  }

  function setSlotCount(n) {
    while (slots().length < n) {
      const slot = newSlot();
      sizeSlot(slot, pageSize);
      pages.appendChild(slot);
    }
    while (slots().length > n) pages.lastChild.remove();
  }

  function updateSlots() {
    if (done) knownTotal = pageCount;
    const want = done ? pageCount : pageCount + 1;
    // pages go away only when the document is finished (TeXpresso starts
    // again from page 1 for its second pass)
    setSlotCount(done ? want : Math.max(want, slots().length));
    if (caret && !caretEl.parentElement) placeCaret(false);
    writeToolbar();
    checkView();
  }

  // --- zoom, as Overleaf's: 100% = 4/3 CSS pixels per point ---------------
  function scale() {
    const z = settings.zoom;
    if (z.mode === "page-width")
      return Math.max(0.1, (scroller.clientWidth - 24) / (pageSize.w * PT));
    if (z.mode === "page-height")
      return Math.max(0.1, (scroller.clientHeight - 24) / (pageSize.h * PT));
    return z.scale;
  }

  function sizeSlot(slot, size) {
    slot.dataset.w = size.w;
    slot.dataset.h = size.h;
    slot.style.width = Math.round(size.w * PT * scale()) + "px";
    slot.style.aspectRatio = `${size.w} / ${size.h}`;
  }

  function applyZoom() {
    for (const slot of slots())
      sizeSlot(slot, { w: +slot.dataset.w || pageSize.w, h: +slot.dataset.h || pageSize.h });
    writeToolbar();
    sendWidth();
  }

  // zoom around the middle of the view
  function setZoom(mode, value) {
    const before = (scroller.scrollTop + scroller.clientHeight / 2) / (scroller.scrollHeight || 1);
    if (mode === "zoom-in") settings.zoom = { mode: "scale", scale: Math.min(9.99, Math.round(scale() * 110) / 100) };
    else if (mode === "zoom-out") settings.zoom = { mode: "scale", scale: Math.max(0.1, Math.round(scale() / 1.1 * 100) / 100) };
    else if (mode === "scale") settings.zoom = { mode, scale: Math.min(9.99, Math.max(0.1, value)) };
    else settings.zoom = { mode, scale: 1 };
    save();
    applyZoom();
    scroller.scrollTop = before * scroller.scrollHeight - scroller.clientHeight / 2;
    checkView();
  }

  // pictures are made for the page width on screen (sharp on HiDPI)
  function sendWidth() {
    clearTimeout(widthTimer);
    widthTimer = setTimeout(() => {
      if (!active()) return;
      const css = pageSize.w * PT * scale();
      send({ type: "width", width: Math.min(4000, Math.round(css * (window.devicePixelRatio || 1))) });
    }, 150);
  }

  // --- the editor cursor in the PDF (SyncTeX) -----------------------------
  const caretEl = document.createElement("div");
  caretEl.className = "olive-caret";
  // a part of the source that does not map 1:1 to its glyphs (\infty,
  // \ref{...}, a picture): the caret is at its start, and a box shows it all
  const caretBox = document.createElement("div");
  caretBox.className = "olive-caret-box";

  // a box in points [x0, y0, x1, y1] on a page slot, in % of the page
  function placeBox(el, slot, b) {
    const w = +slot.dataset.w || pageSize.w, h = +slot.dataset.h || pageSize.h;
    el.style.left = (b[0] / w * 100) + "%";
    el.style.top = (b[1] / h * 100) + "%";
    el.style.width = ((b[2] - b[0]) / w * 100) + "%";
    el.style.height = ((b[3] - b[1]) / h * 100) + "%";
  }

  function placeCaret(follow) {
    if (!caret || !settings.on) {
      caretEl.remove();
      caretBox.remove();
      return;
    }
    if (caret.page >= slots().length) setSlotCount(caret.page + 1);
    const slot = slots()[caret.page];
    if (!slot) return;
    const w = +slot.dataset.w || pageSize.w, h = +slot.dataset.h || pageSize.h;
    caretEl.style.left = (caret.x / w * 100) + "%";
    caretEl.style.top = ((caret.y - caret.h) / h * 100) + "%";
    caretEl.style.height = (Math.max(caret.h + caret.d, 4) / h * 100) + "%";
    // a picture or a TikZ element: only its box, no caret line
    caretEl.classList.toggle("olive-caret-hidden", !!caret.element);
    if (caretEl.parentElement !== slot) slot.appendChild(caretEl);
    if (caret.box) {
      placeBox(caretBox, slot, caret.box);
      if (caretBox.parentElement !== slot) slot.appendChild(caretBox);
    } else {
      caretBox.remove();
    }
    caretEl.classList.remove("olive-caret-stale");
    // start the blink again, as an editor caret does after a move (without
    // a forced layout of the page: the animation itself restarts)
    if (caretEl.getAnimations) for (const a of caretEl.getAnimations()) a.currentTime = 0;
    if (follow) followCaret();
    positionModBar();
  }

  // scroll only when the caret is out of view: then put it a third down
  function followCaret() {
    const r = caretEl.getBoundingClientRect(), b = scroller.getBoundingClientRect();
    if (!r.height) return;
    const margin = 16;
    let dy = 0, dx = 0;
    if (r.top < b.top + margin || r.bottom > b.bottom - margin)
      dy = r.top - (b.top + b.height / 3);
    if (r.left < b.left + margin || r.right > b.right - margin)
      dx = r.left - (b.left + b.width / 2);
    if (dx || dy) {
      scroller.scrollBy({ top: dy, left: dx });
      checkView();
    }
  }

  // reverse search: a double-click on a live page
  pages.addEventListener("dblclick", (e) => {
    const slot = e.target.closest(".olive-slot");
    if (!slot || !connected) return;
    const index = Array.prototype.indexOf.call(slots(), slot);
    const r = slot.getBoundingClientRect();
    const w = +slot.dataset.w || pageSize.w, h = +slot.dataset.h || pageSize.h;
    const x = (e.clientX - r.left) / r.width * w, y = (e.clientY - r.top) / r.height * h;
    e.preventDefault();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    closeField();
    pendingField = null;
    scanPage = index;
    scanAt = performance.now();
    instantOutline(pointOf(e));
    askClick({ type: "scan", page: index, x, y });
  });

  // a click or double-click on a page that the engine is typesetting again
  // (just after an edit): asked again when the page comes, for at most
  // 2 s after the click; a new click replaces it (no stacking)
  let clickAsk = null;
  function askClick(msg) {
    clearTimeout(clickAsk && clickAsk.timer);
    clickAsk = { msg, until: performance.now() + 2000, timer: 0 };
    send(msg);
  }
  function clickNotReady(page) {
    const c = clickAsk;
    if (!c || c.msg.page !== page) return;
    if (performance.now() > c.until) { clickAsk = null; return; }
    c.waiting = true;
    // when the page comes (pageArrived), or after 300 ms at the latest
    clearTimeout(c.timer);
    c.timer = setTimeout(() => clickAgain(c), 300);
  }
  function clickAgain(c) {
    if (clickAsk !== c || !c.waiting) return;
    c.waiting = false;
    clearTimeout(c.timer);
    if (performance.now() > c.until) { clickAsk = null; return; }
    send(c.msg);
  }
  function pageArrived(page) {
    if (clickAsk && clickAsk.waiting && clickAsk.msg.page === page) clickAgain(clickAsk);
  }

  // the file tree item of a project path (or null)
  function treeItemOf(path) {
    for (const el of document.querySelectorAll("[data-file-id]"))
      if (pathOf(el.getAttribute("data-file-id")) === path) return el;
    return null;
  }

  function gotoSource(msg) {
    if (detached) return;            // the editor tab does it
    const cmd = { [TAG + "Cmd"]: "goto", line: msg.line, column: msg.column,
                  toLine: msg.toLine, toColumn: msg.toColumn };
    if (docId && pathOf(docId) === msg.path) {
      window.postMessage({ ...cmd, docId }, location.origin);
      return;
    }
    const item = treeItemOf(msg.path);
    if (!item) {
      setStatus(`can't open ${msg.path}: not in the file tree (open its folder)`, false);
      return;
    }
    pendingGoto = { ...cmd, docId: item.getAttribute("data-file-id") };
    item.click();
    // if Overleaf does not report the file as opened, try anyway
    const mine = pendingGoto;
    setTimeout(() => {
      if (pendingGoto === mine) {
        pendingGoto = null;
        window.postMessage(mine, location.origin);
      }
    }, 2500);
  }

  // --- which pages are in view ------------------------------------------
  function visibleRange() {
    const box = scroller.getBoundingClientRect();
    let first = -1, last = -1;
    for (let i = 0; i < slots().length; i++) {
      const r = slots()[i].getBoundingClientRect();
      if (r.bottom >= box.top && r.top <= box.bottom) {
        if (first < 0) first = i;
        last = i;
      } else if (first >= 0) break;
    }
    return { first: Math.max(first, 0), last: Math.max(last, first, 0) };
  }

  function currentPage() {
    const box = scroller.getBoundingClientRect();
    for (let i = 0; i < slots().length; i++)
      if (slots()[i].getBoundingClientRect().bottom > box.top + box.height / 3) return i;
    return 0;
  }

  function totalShown() {
    const total = done ? pageCount : Math.max(pageCount, knownTotal);
    return { total: Math.max(total, 1), more: !done && pageCount >= knownTotal };
  }

  // tell the helper which pages are in view (plus one below, so that
  // scrolling down shows a finished page)
  let viewFrame = 0;
  function checkView() {
    if (viewFrame) return;
    viewFrame = requestAnimationFrame(() => {
      viewFrame = 0;
      if (!active()) return;
      const r = visibleRange();
      r.last += 1;
      if (r.first !== view.first || r.last !== view.last) {
        view = r;
        send({ type: "view", first: r.first, last: r.last });
        scheduleCache(150);
        try { dbg.view(); } catch (e) { /* not set up yet */ }
      }
      writeToolbar();
    });
  }
  scroller.addEventListener("scroll", checkView, { passive: true });
  scroller.addEventListener("scroll", () => positionModBar(), { passive: true });

  function gotoPage(n) {
    const { total } = totalShown();
    n = Math.max(0, Math.min(n, Math.max(slots().length, total) - 1));
    if (n >= slots().length) setSlotCount(n + 1);
    scroller.scrollTo({ top: slots()[n].offsetTop - 8 });
    checkView();
  }

  // Ctrl + wheel and pinch (a trackpad sends Ctrl + wheel): smooth zoom
  // around the mouse (the point under it stays under it); one zoom per frame
  let wheelZoom = null;
  scroller.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const factor = Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.0035);
    if (!wheelZoom) {
      // the slot under the mouse and the point in it (fractions)
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const slot = el && el.closest && el.closest(".olive-slot");
      let fx = 0.5, fy = 0.5;
      if (slot) {
        const r = slot.getBoundingClientRect();
        fx = (e.clientX - r.left) / r.width;
        fy = (e.clientY - r.top) / r.height;
      }
      wheelZoom = { factor: 1, slot, fx, fy, x: e.clientX, y: e.clientY };
      requestAnimationFrame(() => {
        const z = wheelZoom;
        wheelZoom = null;
        settings.zoom = { mode: "scale", scale: Math.min(9.99, Math.max(0.1, scale() * z.factor)) };
        applyZoom();
        if (z.slot && z.slot.isConnected) {
          const r = z.slot.getBoundingClientRect();
          scroller.scrollLeft += r.left + z.fx * r.width - z.x;
          scroller.scrollTop += r.top + z.fy * r.height - z.y;
        }
        checkView();
        clearTimeout(zoomSaveTimer);
        zoomSaveTimer = setTimeout(save, 500);
      });
    }
    wheelZoom.factor *= factor;
  }, { passive: false });
  let zoomSaveTimer = null;
  scroller.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const action = { "+": "zoom-in", "=": "zoom-in", "-": "zoom-out", "0": "page-width", "9": "page-height" }[e.key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    setZoom(action);
  });

  // --- Overleaf's PDF toolbar drives the live pages ----------------------
  // Overleaf's toolbar is React and controls Overleaf's own PDF (pdf.js),
  // which stays under the live pages. While Live is on, clicks on its page
  // and zoom controls are caught before Overleaf gets them, and the page
  // number and zoom shown are the live ones. The theme button is left to
  // Overleaf: it sets .pdf-dark-mode, which the live pages follow (CSS).
  const controls = () => document.querySelector("#toolbar-pdf-controls");

  function toolbarParts() {
    const c = controls();
    if (!c) return {};
    const pageBox = c.querySelector(".pdfjs-page-number-input");
    const pageButtons = pageBox && pageBox.previousElementSibling &&
      pageBox.previousElementSibling.matches(".pdfjs-toolbar-buttons")
      ? pageBox.previousElementSibling.querySelectorAll("button") : [];
    return {
      prev: pageButtons[0], next: pageButtons[1],
      pageInput: pageBox && pageBox.querySelector("input"),
      pageTotal: pageBox && pageBox.querySelector("span"),
      zoomButtons: c.querySelectorAll(".pdfjs-zoom-controls .pdfjs-toolbar-buttons button"),
      zoomLabel: document.querySelector("#pdf-zoom-dropdown"),
    };
  }

  // what Overleaf (React) wrote, to put back when Live is turned off
  const original = new Map();    // element -> {text, value, disabled}
  function setText(el, text) {
    if (!el || el.textContent === text) return;
    if (!original.has(el)) original.set(el, {});
    const o = original.get(el);
    if (o.ours !== el.textContent) o.text = el.textContent;   // React changed it
    el.textContent = text;
    o.ours = text;
  }
  function setValue(el, value) {
    if (!el || el.value === value || document.activeElement === el) return;
    if (!original.has(el)) original.set(el, {});
    const o = original.get(el);
    if (o.oursValue !== el.value) o.value = el.value;
    el.value = value;
    o.oursValue = value;
  }
  function setDisabled(el, disabled) {
    if (!el || el.disabled === disabled) return;
    if (!original.has(el)) original.set(el, {});
    const o = original.get(el);
    if (o.oursDisabled !== el.disabled) o.disabled = el.disabled;
    el.disabled = disabled;
    o.oursDisabled = disabled;
  }
  function restoreToolbar() {
    for (const [el, o] of original) {
      if (!el.isConnected) continue;
      if (o.text !== undefined) el.textContent = o.text;
      if (o.value !== undefined) el.value = o.value;
      if (o.disabled !== undefined) el.disabled = o.disabled;
    }
    original.clear();
  }

  function writeToolbar() {
    if (!active()) return;
    const t = toolbarParts();
    const { total, more } = totalShown();
    const n = Math.min(currentPage() + 1, total);
    setValue(t.pageInput, String(n));
    setText(t.pageTotal, `/ ${total}${more ? "+" : ""}`);
    setDisabled(t.prev, n <= 1);
    setDisabled(t.next, done && n >= total);
    setText(t.zoomLabel, `${Math.round(scale() * 100)}%`);
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function closeZoomMenu() {
    const toggle = document.querySelector("#pdf-zoom-dropdown");
    if (toggle && toggle.getAttribute("aria-expanded") === "true") {
      toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (toggle.getAttribute("aria-expanded") === "true") toggle.click();
    }
  }

  window.addEventListener("click", (e) => {
    if (!active()) return;
    const button = e.target.closest && e.target.closest("button");
    if (!button || !controls()) return;
    const t = toolbarParts();
    if (button === t.prev) { block(e); gotoPage(currentPage() - 1); return; }
    if (button === t.next) { block(e); gotoPage(currentPage() + 1); return; }
    if (button === t.zoomButtons[0]) { block(e); setZoom("zoom-out"); return; }
    if (button === t.zoomButtons[1]) { block(e); setZoom("zoom-in"); return; }
    // the zoom menu: zoom in, zoom out, fit width, fit height, (present), 50%..400%
    const menuEl = button.closest(".pdfjs-zoom-dropdown-menu");
    if (menuEl) {
      const items = [...menuEl.querySelectorAll("button.dropdown-item")];
      const i = items.indexOf(button);
      const percent = button.textContent.trim().match(/^(\d+)\s*%$/);
      let action = null;
      if (percent) action = ["scale", +percent[1] / 100];
      else if (i >= 0 && i < 4) action = [["zoom-in", "zoom-out", "page-width", "page-height"][i]];
      if (!action) return;                 // e.g. presentation mode: Overleaf's own
      block(e);
      setZoom(...action);
      closeZoomMenu();
    }
  }, true);

  // the page number box: Enter, or leaving it
  function pageFromInput(input) {
    const n = parseInt(input.value, 10);
    if (!isNaN(n)) gotoPage(n - 1);
    writeToolbar();
  }
  window.addEventListener("submit", (e) => {
    if (!active()) return;
    const t = toolbarParts();
    if (t.pageInput && e.target.contains(t.pageInput)) { block(e); pageFromInput(t.pageInput); }
  }, true);
  window.addEventListener("focusout", (e) => {
    if (!active()) return;
    const t = toolbarParts();
    if (e.target === t.pageInput) {
      e.stopImmediatePropagation();
      e.stopPropagation();
      setTimeout(() => pageFromInput(t.pageInput), 0);
    }
  }, true);
  // the custom zoom box in the zoom menu
  window.addEventListener("keydown", (e) => {
    if (!active() || e.key !== "Enter") return;
    const box = e.target.closest && e.target.closest(".pdfjs-custom-zoom-menu-item");
    if (!box) return;
    const percent = parseFloat(e.target.value);
    block(e);
    if (!isNaN(percent)) setZoom("scale", percent / 100);
    closeZoomMenu();
  }, true);

  // --- placing the viewer -------------------------------------------------
  // Overleaf redraws its panes: put the viewer back when it disappears, and
  // keep the toolbar showing the live values
  let domFrame = 0;
  function attach() {
    const host = document.querySelector(".pdf-viewer");
    if (host && ui.parentElement !== host) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.appendChild(ui);
      applyZoom();
      view = { first: -1, last: -1 };
      checkView();
    }
    writeToolbar();
  }
  new MutationObserver(() => {
    if (!domFrame) domFrame = requestAnimationFrame(() => { domFrame = 0; attach(); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  attach();
  new ResizeObserver(() => { applyZoom(); checkView(); }).observe(scroller);

  // --- hover, clicks, links, selection, find ------------------------------
  // The engine sends a map of each page it shows (pageMap): its text lines
  // with the position of each character, and its links. With it the viewer
  // sets the mouse cursor (text, link), follows links, selects and copies
  // text, and finds text. What a double-click would edit comes from the
  // engine (probe), asked when the mouse stops; the answer is kept for its
  // box until the page changes.
  const pageMaps = new Map();       // page -> {w, h, lines: [[x0,y0,x1,y1,text,[x...]]], links}
  const editable = new Map();       // page -> [{box, kind}] (from probes)
  const hoverBox = document.createElement("div");
  hoverBox.className = "olive-hover-box";
  let hoverPt = null, probeTimer = null, probeBusy = false, probeNext = null, lastProbe = null;

  // the page and the point (in points) of a mouse event, or null
  function pointOf(e) {
    const slot = e.target.closest && e.target.closest(".olive-slot");
    if (!slot || !pages.contains(slot)) return null;
    const page = Array.prototype.indexOf.call(slots(), slot);
    const r = slot.getBoundingClientRect();
    const w = +slot.dataset.w || pageSize.w, h = +slot.dataset.h || pageSize.h;
    return { slot, page, x: (e.clientX - r.left) / r.width * w, y: (e.clientY - r.top) / r.height * h };
  }

  const inBox = (b, x, y, m = 0) => x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m;

  function linkAt(pt) {
    const map = pageMaps.get(pt.page);
    return map && map.links.find((l) => inBox(l, pt.x, pt.y, 1));
  }

  function lineAt(pt) {
    const map = pageMaps.get(pt.page);
    if (!map) return -1;
    return map.lines.findIndex((l) => inBox(l, pt.x, pt.y, 1));
  }

  function editableAt(pt) {
    const list = editable.get(pt.page);
    // (1.5 pt around the box: the engine's answer also counts a point just
    // outside the glyphs)
    return list && list.find((e) => inBox(e.box, pt.x, pt.y, 1.5));
  }

  // the cursor and the outline for the point under the mouse
  function hover(pt) {
    hoverPt = pt;
    if (!pt) { hoverBox.remove(); return; }
    const link = linkAt(pt), ed = !link && editableAt(pt);
    let cursor = "default";
    if (link) cursor = "pointer";
    else if (ed) cursor = "grab";
    else if (lineAt(pt) >= 0) cursor = "text";
    if (pt.slot.style.cursor !== cursor) pt.slot.style.cursor = cursor;
    pt.slot.title = link ? (link[4].startsWith("url:") ? link[4].slice(4) : "Go to " + link[4].slice(5)) : "";
    if (ed) {
      placeBox(hoverBox, pt.slot, ed.box);
      if (hoverBox.parentElement !== pt.slot) pt.slot.appendChild(hoverBox);
    } else {
      hoverBox.remove();
    }
    // not in the cache (or no cache yet): the engine is asked, and its answer
    // is kept for the box
    if (!link && !ed) {
      clearTimeout(probeTimer);
      const near = lastProbe && lastProbe.page === pt.page &&
                   Math.abs(lastProbe.x - pt.x) < 2 && Math.abs(lastProbe.y - pt.y) < 2;
      if (!near) probeTimer = setTimeout(() => probe(pt), 80);
    }
  }

  function probe(pt) {
    if (!connected || selecting) return;
    if (probeBusy) { probeNext = pt; return; }
    probeBusy = true;
    lastProbe = { page: pt.page, x: pt.x, y: pt.y, at: performance.now() };
    send({ type: "probe", page: pt.page, x: pt.x, y: pt.y });
    // no answer (an old engine): free again
    setTimeout(() => { probeBusy = false; }, 1500);
  }

  function onProbe(msg) {
    probeBusy = false;
    // latency: from the probe (80 ms after the mouse stopped) to the answer
    if (lastProbe && lastProbe.at && (msg.kind === "field" || msg.kind === "choice")) {
      latency("hover → cursor (engine)", performance.now() - lastProbe.at + 80,
              cacheState.get(msg.page) === "ok" ? "not in the cache" : "no cache yet");
    }
    if (lastProbe) lastProbe.at = 0;
    const b = msg.box;
    if ((msg.kind === "field" || msg.kind === "choice") && b[2] > b[0] && b[3] > b[1]) {
      const list = editable.get(msg.page) || [];
      if (!list.some((e) => e.box.join() === b.join())) list.push({ box: b, kind: msg.kind });
      editable.set(msg.page, list);
    }
    if (probeNext) { const p = probeNext; probeNext = null; probe(p); }
    else if (hoverPt && hoverPt.page === msg.page) hover(hoverPt);
  }

  // a page changed: its map, its editable boxes and its carets are old
  function pageChanged(page) {
    editable.delete(page);
    dropCache(page);
    if (lastProbe && lastProbe.page === page) lastProbe = null;
    scheduleCache(400);
  }

  // The cache of the pages in view (and of the caret's page): what a
  // double-click edits (so the hover cursor needs no engine answer) and the
  // caret of each character (so the caret moves at once with the editor
  // cursor; the engine's answer then corrects it). The engine makes it when
  // the pages in view are done. An edit makes it old.
  const caretCache = new Map();     // page -> Map(path -> Map(line -> Map(col -> [x, y, h, d])))
  const cacheState = new Map();     // page -> "asked" | "ok"
  let cacheTimer = 0;
  function scheduleCache(delay) {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(askCache, delay);
  }
  function askCache() {
    if (!connected || !settings.on) return;
    const want = new Set();
    for (let p = Math.max(0, view.first); p <= view.last && p < pageCount; p++) want.add(p);
    if (caret && caret.page < pageCount) want.add(caret.page);
    for (const p of want) {
      if (cacheState.has(p)) continue;
      cacheState.set(p, "asked");
      send({ type: "pageCache", page: p });
    }
  }
  function dropCache(page) {
    cacheState.delete(page);
    caretCache.delete(page);
  }
  function dropAllCaches() {
    for (const p of [...cacheState.keys()]) { dropCache(p); editable.delete(p); }
  }
  function onPageCache(msg) {
    if (cacheState.get(msg.page) !== "asked") return;   // old: the page changed meanwhile
    cacheState.set(msg.page, "ok");
    editable.set(msg.page, msg.fields.map((f) => ({ box: f.box, kind: f.kind === "s" ? "choice" : "field" })));
    const files = new Map();
    for (const f of msg.files) {
      const lines = files.get(f.path) || new Map();
      for (const [l, c, x, y, h, d] of f.pts) {
        if (!lines.has(l)) lines.set(l, new Map());
        lines.get(l).set(c, [x, y, h, d]);
      }
      files.set(f.path, lines);
    }
    caretCache.set(msg.page, files);
    if (hoverPt && hoverPt.page === msg.page) hover(hoverPt);
  }
  // --- the module toolbar ---
  // When the editor cursor is in a state machine, circuit, Karnaugh map or
  // truth table, a toolbar shows near it on the page (by the caret): its
  // buttons open small forms that write the change into the source
  // (modedit.js has the text logic).
  const modBar = $(".olive-modbar"), modForm = $(".olive-modform");
  let modNow = null;            // {mod, path, offset} of the cursor's module
  function cursorOffset(text, line, col) {
    let a = 0;
    for (let i = 1; i < line; i++) {
      a = text.indexOf("\n", a);
      if (a < 0) return -1;
      a++;
    }
    return a + col;
  }
  function lineCol(text, off) {
    let line = 1, ls = 0;
    for (let i = text.indexOf("\n"); i >= 0 && i < off; i = text.indexOf("\n", i + 1)) { line++; ls = i + 1; }
    return [line, off - ls];
  }
  function currentModule() {
    const lc = lastCursor, text = lc && lastText.get(lc.path);
    if (!text || !globalThis.OliveModEdit || !settings.on || !connected || detached) return null;
    const offset = cursorOffset(text, lc.line, lc.column);
    if (offset < 0) return null;
    const mod = OliveModEdit.find(text, offset);
    return mod && mod.actions.length ? { mod, path: lc.path, offset, text } : null;
  }
  function updateModBar() {
    if (!modForm.hidden) return;              // a form is open: it stays
    const now = currentModule();
    const key = now && `${now.path}:${now.mod.env.begin}:${now.mod.title}:${now.mod.actions.map((a) => a.id).join()}`;
    if (!now) { modNow = null; modBar.hidden = true; return; }
    if (!modNow || modNow.key !== key) {
      modBar.textContent = "";
      const title = document.createElement("span");
      title.className = "olive-modbar-title";
      title.textContent = now.mod.title;
      modBar.appendChild(title);
      for (const a of now.mod.actions) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        b.addEventListener("click", (e) => { e.stopPropagation(); openModForm(a.id); });
        modBar.appendChild(b);
      }
    }
    modNow = { ...now, key };
    modBar.hidden = false;
    positionModBar();
  }
  // above the caret's box (or the caret) on the page; at the top of the
  // pane if the caret is not in view
  function positionModBar() {
    if (modBar.hidden) return;
    const pane = $(".olive-pane").getBoundingClientRect();
    let top = 8, left = 12;
    const slot = caret && slots()[caret.page];
    if (slot) {
      const r = slot.getBoundingClientRect(), k = r.width / (+slot.dataset.w || pageSize.w);
      const b = caret.box || [caret.x, caret.y - caret.h, caret.x, caret.y + caret.d];
      const y = r.top + b[1] * k - pane.top, x = r.left + b[0] * k - pane.left;
      const h = modBar.offsetHeight || 30;
      if (y - h - 6 > 0 && y < pane.height) { top = y - h - 6; left = x; }
      else if (y + 8 < pane.height && y > 0) { top = y + 8; left = x; }
    }
    left = Math.max(8, Math.min(left, pane.width - modBar.offsetWidth - 24));
    modBar.style.top = top + "px";
    modBar.style.left = left + "px";
    if (!modForm.hidden) {
      modForm.style.top = (top + modBar.offsetHeight + 4) + "px";
      modForm.style.left = left + "px";
    }
  }
  function closeModForm() {
    modForm.hidden = true;
    modForm.textContent = "";
    updateModBar();
  }
  function modFormError(text) {
    const e = modForm.querySelector(".olive-modform-error");
    if (e) e.textContent = text;
  }
  function openModForm(id) {
    const now = currentModule();
    const a = now && now.mod.actions.find((x) => x.id === id);
    if (!a) return;
    modForm.textContent = "";
    const head = document.createElement("div");
    head.className = "olive-modform-head";
    head.textContent = a.label.replace(/^\+ /, "Add ");
    modForm.appendChild(head);
    const inputs = {};
    for (const f of a.fields()) {
      if (f.type === "note") {
        const n = document.createElement("div");
        n.className = "olive-modform-note";
        n.textContent = f.note;
        modForm.appendChild(n);
        continue;
      }
      const row = document.createElement("label");
      row.className = "olive-modform-row";
      row.append(f.label + " ");
      let input;
      if (f.type === "select" && !f.editable) {
        input = document.createElement("select");
        for (const o of f.options) {
          const op = document.createElement("option");
          op.value = op.textContent = o;
          input.appendChild(op);
        }
        if (f.value !== undefined && f.options.includes(f.value)) input.value = f.value;
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = f.value ?? (f.options ? f.options[0] : "");
        if (f.options) {
          const dl = document.createElement("datalist");
          dl.id = "olive-dl-" + f.name;
          for (const o of f.options) { const op = document.createElement("option"); op.value = o; dl.appendChild(op); }
          row.appendChild(dl);
          input.setAttribute("list", dl.id);
        }
      }
      input.name = f.name;
      inputs[f.name] = input;
      row.appendChild(input);
      modForm.appendChild(row);
      if (f.note) {
        const n = document.createElement("div");
        n.className = "olive-modform-note";
        n.textContent = f.note;
        modForm.appendChild(n);
      }
    }
    const err = document.createElement("div");
    err.className = "olive-modform-error";
    modForm.appendChild(err);
    const buttons = document.createElement("div");
    buttons.className = "olive-modform-buttons";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "olive-modform-ok";
    ok.textContent = "OK";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    buttons.append(ok, cancel);
    modForm.appendChild(buttons);
    const submit = () => {
      // with the text as it is now (it can have changed since the form opened)
      const cur = currentModule();
      const act = cur && cur.mod.kind === now.mod.kind && cur.mod.actions.find((x) => x.id === id);
      if (!act) { err.textContent = "the cursor is no longer in this module"; return; }
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
      let edits;
      try { edits = act.run(values); } catch (e) { err.textContent = e.message; return; }
      if (!edits.length) { closeModForm(); return; }
      const text = cur.text;
      const out = edits.map((e) => {
        const [l0, c0] = lineCol(text, e.from), [l1, c1] = lineCol(text, e.to);
        return { line: l0, column: c0, toLine: l1, toColumn: c1, text: e.text, expect: text.slice(e.from, e.to) };
      });
      window.postMessage({ [TAG + "Cmd"]: "replace", docId, edits: out, id: "modbar" }, location.origin);
    };
    ok.addEventListener("click", submit);
    cancel.addEventListener("click", closeModForm);
    modForm.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); closeModForm(); }
      e.stopPropagation();
    };
    modForm.hidden = false;
    positionModBar();
    const first = modForm.querySelector("input, select");
    if (first) { first.focus(); if (first.select) first.select(); }
  }
  document.addEventListener("mousedown", (e) => {
    if (!modForm.hidden && !modForm.contains(e.target) && !modBar.contains(e.target)) closeModForm();
  }, true);

  // --- caret prediction while typing ---
  // After a key the engine gives the caret only when it has typeset the page
  // again (some 100 ms); while one types, each key starts it again, so the
  // caret would stand still. So the caret is predicted from the last known
  // carets of the cursor's line: a column whose text before it did not
  // change keeps its place; after it, each character adds about one
  // character width. The engine's answer then replaces the prediction.
  let predBase = null;
  function lineOf(text, n) {
    let a = 0;
    for (let i = 1; i < n; i++) {
      a = text.indexOf("\n", a);
      if (a < 0) return null;
      a++;
    }
    const b = text.indexOf("\n", a);
    return b < 0 ? text.slice(a) : text.slice(a, b);
  }
  function lineCount(text) {
    let n = 1;
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
    return n;
  }
  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }
  // a known caret (from the engine or the cache) for lastCursor
  function setPredBase(pos) {
    const lc = lastCursor, text = lc && lastText.get(lc.path);
    if (!text || !pos || pos.element || pos.box || !(pos.h + pos.d > 0.5)) { predBase = null; return; }
    const lineText = lineOf(text, lc.line), count = lineCount(text);
    if (lineText === null) { predBase = null; return; }
    const map = new Map();
    let maxX = null;
    const files = caretCache.get(pos.page), cols = files && files.get(lc.path) && files.get(lc.path).get(lc.line);
    if (cols) for (const [c, v] of cols) map.set(c, v);
    if (files) for (const lines of files.values()) for (const cs of lines.values()) for (const v of cs.values()) maxX = Math.max(maxX ?? v[0], v[0]);
    const old = predBase;
    if (old && old.path === lc.path && old.line === lc.line && old.count === count && old.page === pos.page) {
      // the carets of the old base before the first change are still right
      const p = commonPrefix(old.lineText, lineText);
      for (const [c, v] of old.map) if (c <= p && !map.has(c)) map.set(c, v);
      if (maxX === null) maxX = old.maxX;
    }
    map.set(lc.column, [pos.x, pos.y, pos.h, pos.d]);
    predBase = { path: lc.path, line: lc.line, lineText, count, page: pos.page, map, maxX };
  }
  function predictCaret(path, line, col) {
    const b = predBase, text = lastText.get(path);
    if (!b || b.path !== path || b.line !== line || !text || lineCount(text) !== b.count) return null;
    const cur = lineOf(text, line);
    if (cur === null) return null;
    const p = commonPrefix(b.lineText, cur);
    // the known carets that are still right: before the first change
    const pts = [...b.map].filter(([c]) => c <= p).sort((u, v) => u[0] - v[0]);
    if (!pts.length) return null;
    // one character's width: from the known carets on the same line
    const y0 = pts[pts.length - 1][1][1], same = pts.filter(([, v]) => Math.abs(v[1] - y0) < 1);
    let w = 0.5 * (pts[0][1][2] + pts[0][1][3]);
    if (same.length > 1) {
      const [c0, v0] = same[0], [c1, v1] = same[same.length - 1];
      if (c1 > c0 && v1[0] > v0[0]) w = (v1[0] - v0[0]) / (c1 - c0);
    }
    let base = pts.filter(([c]) => c <= col).pop() || pts[0];
    const [c, v] = base;
    let x = v[0] + (col - c) * w;
    if (b.maxX !== null && x > b.maxX) x = b.maxX;
    return { page: b.page, x, y: v[1], h: v[2], d: v[3], predicted: true };
  }

  // the caret of a cursor position from the cache (only an exact column),
  // or null
  function cachedCaret(path, line, col) {
    for (const [page, files] of caretCache) {
      const lines = files.get(path), cols = lines && lines.get(line), p = cols && cols.get(col);
      if (p) return { page, x: p[0], y: p[1], h: p[2], d: p[3] };
    }
    return null;
  }

  pages.addEventListener("mousemove", (e) => {
    if (selecting) return;
    hover(pointOf(e));
  });
  pages.addEventListener("mouseleave", () => { hover(null); clearTimeout(probeTimer); });

  // links: a target in the document (the engine finds its page), or a URL
  let pendingDest = null;
  function follow(target) {
    if (target.startsWith("url:")) {
      window.open(target.slice(4), "_blank", "noopener");
      return;
    }
    pendingDest = target.slice(5);
    setStatus("going to the link target…", true);
    send({ type: "findDest", name: pendingDest });
  }

  function onDest(msg) {
    if (msg.name !== pendingDest) return;
    pendingDest = null;
    if (msg.page < 0) { setStatus("link target not found", false); return; }
    setStatus("live", false);
    if (msg.page >= slots().length) setSlotCount(msg.page + 1);
    const slot = slots()[msg.page];
    const h = +slot.dataset.h || pageSize.h;
    scroller.scrollTo({ top: slot.offsetTop + msg.y / h * slot.offsetHeight - 24 });
    checkView();
    // a short mark at the target
    const mark = document.createElement("div");
    mark.className = "olive-dest-mark";
    mark.style.top = (msg.y / h * 100) + "%";
    slot.appendChild(mark);
    setTimeout(() => mark.remove(), 1600);
  }

  // Mouse: a click goes to the source (the editor cursor to the clicked
  // character), a click on a link follows it, a drag selects text (Ctrl+C
  // copies it), a double-click edits (quick edit)
  let down = null, selecting = false, selection = null;   // selection: {a, b} as [page, line, char]
  const selLayers = [];

  function charAt(pt, snap) {
    const map = pageMaps.get(pt.page);
    if (!map) return null;
    let best = null, bd = 1e9;
    map.lines.forEach((l, i) => {
      const dy = pt.y < l[1] ? l[1] - pt.y : pt.y > l[3] ? pt.y - l[3] : 0;
      const dx = pt.x < l[0] ? l[0] - pt.x : pt.x > l[2] ? pt.x - l[2] : 0;
      const d = dy * 4 + dx;
      if (d < bd) { bd = d; best = i; }
    });
    if (best === null || (!snap && bd > 6)) return null;
    const xs = map.lines[best][5];
    let c = 0;
    while (c < xs.length - 1 && (xs[c] + xs[c + 1]) / 2 < pt.x) c++;
    return [pt.page, best, c];
  }

  const cmpPos = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  function clearSelection() {
    selection = null;
    for (const l of selLayers.splice(0)) l.remove();
  }

  // the selected characters, per line: [page, line, from, to]
  function selectedRuns() {
    if (!selection) return [];
    let [a, b] = [selection.a, selection.b];
    if (cmpPos(a, b) > 0) [a, b] = [b, a];
    const runs = [];
    for (let p = a[0]; p <= b[0]; p++) {
      const map = pageMaps.get(p);
      if (!map) continue;
      const l0 = p === a[0] ? a[1] : 0, l1 = p === b[0] ? b[1] : map.lines.length - 1;
      for (let li = l0; li <= l1; li++) {
        const n = map.lines[li][5].length - 1;
        const c0 = p === a[0] && li === a[1] ? a[2] : 0;
        const c1 = p === b[0] && li === b[1] ? b[2] : n;
        if (c1 > c0) runs.push([p, li, c0, c1]);
      }
    }
    return runs;
  }

  function drawSelection() {
    for (const l of selLayers.splice(0)) l.remove();
    const perPage = new Map();
    for (const [p, li, c0, c1] of selectedRuns()) {
      const l = pageMaps.get(p).lines[li];
      if (!perPage.has(p)) perPage.set(p, []);
      perPage.get(p).push([l[5][c0], l[1], l[5][c1], l[3]]);
    }
    for (const [p, boxes] of perPage) {
      const slot = slots()[p];
      if (!slot) continue;
      const layer = document.createElement("div");
      layer.className = "olive-sel-layer";
      for (const b of boxes) {
        const d = document.createElement("div");
        d.className = "olive-sel";
        placeBox(d, slot, b);
        layer.appendChild(d);
      }
      slot.appendChild(layer);
      selLayers.push(layer);
    }
  }

  function selectedText() {
    let out = "", last = null;
    for (const [p, li, c0, c1] of selectedRuns()) {
      const chars = [...pageMaps.get(p).lines[li][4]];
      if (last) out += "\n";
      out += chars.slice(c0, c1).join("");
      last = li;
    }
    return out;
  }

  pages.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".olive-field")) return;
    const pt = pointOf(e);
    if (!pt) return;
    e.preventDefault();                 // no native image drag
    scroller.focus({ preventScroll: true });
    down = { pt, x: e.clientX, y: e.clientY, at: charAt(pt, false) };
    if (!e.shiftKey || !selection) clearSelection();
  });
  window.addEventListener("mousemove", (e) => {
    if (!down) return;
    if (!selecting && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 && down.at) {
      selecting = true;
      hoverBox.remove();
    }
    if (!selecting) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pt = el && pointOf({ target: el, clientX: e.clientX, clientY: e.clientY });
    const at = pt && charAt(pt, true);
    if (!at) return;
    selection = { a: down.at, b: at };
    drawSelection();
  });
  window.addEventListener("mouseup", (e) => {
    if (!down) return;
    const d = down;
    down = null;
    if (selecting) { selecting = false; return; }
    if (e.detail > 1 || !connected) return;     // the double-click does its own
    const link = linkAt(d.pt);
    if (link) { follow(link[4]); return; }
    askClick({ type: "click", page: d.pt.page, x: d.pt.x, y: d.pt.y });
  });

  // Ctrl+C: the selected text; Ctrl+F: find; Ctrl+Z: undo in the editor
  scroller.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "c" && selection) {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(selectedText()).then(
        () => setStatus("copied", false), () => setStatus("could not copy", false));
    } else if (k === "f") {
      e.preventDefault();
      e.stopPropagation();
      openFind();
    } else if (k === "z" && !detached) {
      e.preventDefault();
      e.stopPropagation();
      window.postMessage({ [TAG + "Cmd"]: e.shiftKey ? "redo" : "undo" }, location.origin);
    }
  });
  // Ctrl+F with the mouse over the pages (the focus may be in the editor)
  window.addEventListener("keydown", (e) => {
    if (!active() || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f" || !hoverPt) return;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".cm-editor")) return;
    e.preventDefault();
    e.stopPropagation();
    openFind();
  }, true);

  // --- find -------------------------------------------------------------
  const findBar = document.createElement("div");
  findBar.className = "olive-find";
  findBar.innerHTML = `<input type="text" placeholder="Find in the preview" spellcheck="false">
    <span class="olive-find-count"></span>
    <button type="button" class="olive-find-prev" title="Previous (Shift+Enter)">&#x2191;</button>
    <button type="button" class="olive-find-next" title="Next (Enter)">&#x2193;</button>
    <button type="button" class="olive-find-close" title="Close (Esc)">&#x2715;</button>`;
  findBar.hidden = true;
  pane.appendChild(findBar);
  const findInput = findBar.querySelector("input");
  let matches = [], matchIndex = -1;
  const findLayers = [];
  const norm = (t) => t.normalize("NFKC").toLowerCase();

  function openFind() {
    findBar.hidden = false;
    const sel = selection && selectedText();
    if (sel && sel.length < 60 && !sel.includes("\n")) findInput.value = sel;
    findInput.focus();
    findInput.select();
    // the text of all pages typeset so far
    if (pageCount > 0) send({ type: "pageMaps", first: 0, last: pageCount - 1 });
    runFind(false);
  }

  function closeFind() {
    findBar.hidden = true;
    matches = [];
    drawFind();
    scroller.focus({ preventScroll: true });
  }

  // matches: [page, [[line, from, to]...]]; a match may go over lines
  function runFind(keep) {
    const q = norm(findInput.value.trim());
    const before = matches[matchIndex];
    matches = [];
    if (q) {
      for (const p of [...pageMaps.keys()].sort((a, b) => a - b)) {
        const map = pageMaps.get(p);
        let text = "";
        const where = [];                 // per char of text: [line, char]
        map.lines.forEach((l, li) => {
          [...l[4]].forEach((ch, ci) => {
            const n = norm(ch);
            for (const c of n) { text += c; where.push([li, ci]); }
          });
          text += " ";
          where.push([li, -1]);
        });
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
          const parts = [];
          for (let k = i; k < i + q.length; k++) {
            const [li, ci] = where[k];
            if (ci < 0) continue;
            const last = parts[parts.length - 1];
            if (last && last[0] === li) last[2] = ci + 1;
            else parts.push([li, ci, ci + 1]);
          }
          matches.push([p, parts]);
        }
      }
    }
    matchIndex = matches.length ? 0 : -1;
    if (keep && before) {
      const k = matches.findIndex((m) => m[0] === before[0] && m[1][0][0] === before[1][0][0] &&
                                         m[1][0][1] === before[1][0][1]);
      if (k >= 0) matchIndex = k;
    }
    drawFind();
    if (!keep) showMatch();
  }

  function drawFind() {
    for (const l of findLayers.splice(0)) l.remove();
    findBar.querySelector(".olive-find-count").textContent =
      findInput.value.trim() ? (matches.length ? `${matchIndex + 1}/${matches.length}` : "0/0") : "";
    const perPage = new Map();
    matches.forEach(([p, parts], i) => {
      const map = pageMaps.get(p);
      for (const [li, c0, c1] of parts) {
        const l = map.lines[li];
        if (!perPage.has(p)) perPage.set(p, []);
        perPage.get(p).push([[l[5][c0], l[1], l[5][c1], l[3]], i === matchIndex]);
      }
    });
    for (const [p, boxes] of perPage) {
      const slot = slots()[p];
      if (!slot) continue;
      const layer = document.createElement("div");
      layer.className = "olive-sel-layer";
      for (const [b, cur] of boxes) {
        const d = document.createElement("div");
        d.className = "olive-find-hit" + (cur ? " olive-find-current" : "");
        placeBox(d, slot, b);
        layer.appendChild(d);
      }
      slot.appendChild(layer);
      findLayers.push(layer);
    }
  }

  function showMatch() {
    const m = matches[matchIndex];
    if (!m) return;
    const slot = slots()[m[0]];
    const l = pageMaps.get(m[0]).lines[m[1][0][0]];
    const h = +slot.dataset.h || pageSize.h;
    const y = slot.offsetTop + l[1] / h * slot.offsetHeight;
    if (y < scroller.scrollTop + 20 || y > scroller.scrollTop + scroller.clientHeight - 40)
      scroller.scrollTo({ top: y - scroller.clientHeight / 3 });
    checkView();
  }

  function step(d) {
    if (!matches.length) return;
    matchIndex = (matchIndex + d + matches.length) % matches.length;
    drawFind();
    showMatch();
  }

  findInput.addEventListener("input", () => runFind(false));
  findInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  findBar.querySelector(".olive-find-prev").addEventListener("click", () => step(-1));
  findBar.querySelector(".olive-find-next").addEventListener("click", () => step(1));
  findBar.querySelector(".olive-find-close").addEventListener("click", closeFind);

  function onPageMap(msg) {
    pageMaps.set(msg.page, msg.map);
    pageChanged(msg.page);
    if (selection) drawSelection();
    if (!findBar.hidden) runFind(true);
    if (hoverPt && hoverPt.page === msg.page) hover(hoverPt);
  }


  // --- quick edit -------------------------------------------------------
  // A double-click on a field (the smallest $...$, {...} or [...] around the
  // clicked character, e.g. R_1 in \comp{a}{b}{R=$R_1$}): the editor selects
  // its source, and an edit box opens on the page. Enter writes the new text
  // into the editor (page.js checks that the source is still the same),
  // Escape or a click elsewhere closes the box.
  let fieldEl = null;

  function closeField() {
    if (fieldEl) fieldEl.remove();
    fieldEl = null;
  }

  function openField(f) {
    closeField();
    if (detached || scanPage < 0) return;   // the editor is in the other tab
    const slot = slots()[scanPage];
    if (!slot) return;
    if (scanAt) { latency("double-click → edit box", performance.now() - scanAt); scanAt = 0; }
    for (const el of slot.querySelectorAll(".olive-instant-outline")) el.remove();
    const box = document.createElement("div");
    box.className = "olive-field";
    const input = document.createElement("input");
    input.type = "text";
    input.value = f.text;
    input.spellcheck = false;
    input.style.width = Math.max(8, Math.min(60, f.text.length + 3)) + "ch";
    const hint = document.createElement("span");
    hint.className = "olive-field-hint";
    hint.textContent = "Enter: done · Esc: undo · Tab: next argument";
    box.append(input);
    // values the module offers (e.g. gate types): a click puts one in place
    // of the field and saves; typing still works for any other value
    if (f.options && f.options.length) {
      const list = document.createElement("div");
      list.className = "olive-field-options";
      const [s0, s1] = f.sel || [0, f.text.length];
      for (const opt of f.options) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = opt;
        if (opt === f.text.slice(s0, s1)) b.classList.add("olive-current");
        b.addEventListener("mousedown", (e) => e.preventDefault());   // keep the focus in the box
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          input.value = f.text.slice(0, s0) + opt + f.text.slice(s1);
          instantValue(slot, f.box, opt);
          save();
        });
        list.appendChild(b);
      }
      box.appendChild(list);
    }
    box.append(hint);
    const w = +slot.dataset.w || pageSize.w, h = +slot.dataset.h || pageSize.h;
    box.style.left = (f.box[0] / w * 100) + "%";
    box.style.top = (f.box[3] / h * 100) + "%";
    slot.appendChild(box);
    fieldEl = box;
    for (const ev of ["mousedown", "dblclick", "wheel"]) box.addEventListener(ev, (e) => e.stopPropagation());
    // Live typing: each change goes into the editor at once (so the page
    // changes while you type); Esc puts the old text back. A name with other
    // places (a state) changes at Enter only (all places at once).
    const live = !(f.also && f.also.length);
    let cur = f.text, liveTimer = null;
    const cps = (t) => [...t].length;
    const endOf = (t) => {
      const lines = t.split("\n");
      return lines.length === 1 ? [f.from[0], f.from[1] + cps(t)]
                                : [f.from[0] + lines.length - 1, cps(lines[lines.length - 1])];
    };
    function put(text) {
      if (text === cur) return true;
      if (!docId || pathOf(docId) !== f.path) {
        setStatus(`quick edit not saved: ${f.path} is not open in the editor`, false);
        return false;
      }
      const [tl, tc] = endOf(cur);
      window.postMessage({ [TAG + "Cmd"]: "replace", docId, line: f.from[0], column: f.from[1],
        toLine: tl, toColumn: tc, expect: cur, text }, location.origin);
      cur = text;
      return true;
    }
    function save() {
      clearTimeout(liveTimer);
      const text = input.value;
      closeField();
      if (live) { put(text); return; }
      if (text === f.text) return;
      if (!docId || pathOf(docId) !== f.path) {
        setStatus(`quick edit not saved: ${f.path} is not open in the editor`, false);
        return;
      }
      // a name (a state) with other places: when only the name changed, the
      // name everywhere (the other places are as long as the old name)
      const [s0, s1] = f.sel || [0, f.text.length];
      const pre = f.text.slice(0, s0), post = f.text.slice(s1), old = f.text.slice(s0, s1);
      if (f.from[0] === f.to[0] && text.startsWith(pre) && text.endsWith(post) &&
          text.length >= pre.length + post.length) {
        const name = text.slice(pre.length, text.length - post.length);
        const at = [[f.from[0], f.from[1] + s0], ...f.also];
        const edits = at.map(([l, c]) => ({ line: l, column: c, toLine: l, toColumn: c + [...old].length,
                                            expect: old, text: name }));
        window.postMessage({ [TAG + "Cmd"]: "replace", docId, edits }, location.origin);
        setStatus(`renamed in ${at.length} places`, false);
        return;
      }
      window.postMessage({ [TAG + "Cmd"]: "replace", docId, line: f.from[0], column: f.from[1],
        toLine: f.to[0], toColumn: f.to[1], expect: f.text, text }, location.origin);
    }
    function cancel() {
      clearTimeout(liveTimer);
      closeField();
      if (live) put(f.text);
    }
    if (live) input.addEventListener("input", () => {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => { if (fieldEl === box) put(input.value); }, 120);
    });
    // Tab / Shift+Tab: the next / previous argument ({...} or [...]) in the box
    function groups(t) {
      const out = [];
      let depth = 0, start = -1;
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c === "\\") { i++; continue; }
        if (c === "{" || c === "[") { if (depth++ === 0) start = i + 1; }
        else if ((c === "}" || c === "]") && depth > 0 && --depth === 0) out.push([start, i]);
      }
      return out;
    }
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Tab") {
        e.preventDefault();
        const g = groups(input.value);
        if (!g.length) return;
        const at = input.selectionStart;
        let k = g.findIndex(([a, b]) => at >= a && at <= b);
        if (k < 0) k = e.shiftKey ? g.length : -1;
        k = (k + (e.shiftKey ? -1 : 1) + g.length) % g.length;
        input.setSelectionRange(g[k][0], g[k][1]);
      }
    });
    input.addEventListener("input", () => {
      input.style.width = Math.max(8, Math.min(60, input.value.length + 3)) + "ch";
    });
    // the editor takes the focus when it opens the file and selects the
    // field: in the first 3 s the box takes it back, later a blur keeps the
    // text and closes the box
    const opened = Date.now();
    input.addEventListener("blur", () => setTimeout(() => {
      if (fieldEl !== box) return;
      if (Date.now() - opened < 3000) input.focus();
      else save();
    }, 150));
    // after the editor took the focus for the selection
    // the field is selected (in a command call, the clicked argument)
    setTimeout(() => {
      input.focus();
      if (f.sel) input.setSelectionRange(f.sel[0], f.sel[1]);
      else input.select();
    }, 250);
  }

  // run(docId) when path is open in the editor: at once, or after it was
  // opened (the cursor goes to line, column)
  function whenOpen(path, line, column, run) {
    if (docId && pathOf(docId) === path) { run(docId); return; }
    if (detached) { setStatus(`not changed: ${path} is not open in the editor`, false); return; }
    afterOpen = { path, run: () => run(docId) };
    gotoSource({ path, line, column });
  }

  // A choice (a K-map cell: 0, 1 or D): a small menu on the page; a click
  // makes the edits of that value in the editor (page.js checks that the
  // source is still the same). Esc or a click elsewhere closes it.
  function openChoice(c) {
    closeField();
    if (detached || scanPage < 0) return;
    const slot = slots()[scanPage];
    if (!slot) return;
    if (scanAt) { latency("double-click → edit box", performance.now() - scanAt); scanAt = 0; }
    for (const el of slot.querySelectorAll(".olive-instant-outline")) el.remove();
    const box = document.createElement("div");
    box.className = "olive-field olive-choice";
    const list = document.createElement("div");
    list.className = "olive-field-options";
    for (const o of c.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o.label;
      if (o.label === c.current) b.classList.add("olive-current");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closeField();
        if (!o.edits.length) return;
        instantValue(slot, c.box, o.label);
        const edits = o.edits.map(ed => ({ line: ed.from[0], column: ed.from[1], toLine: ed.to[0],
                                           toColumn: ed.to[1], expect: ed.old, text: ed.text }));
        whenOpen(c.path, edits[0].line, edits[0].column, (id) =>
          window.postMessage({ [TAG + "Cmd"]: "replace", docId: id, edits }, location.origin));
      });
      list.appendChild(b);
    }
    const hint = document.createElement("span");
    hint.className = "olive-field-hint";
    hint.textContent = "Esc: cancel";
    box.append(list, hint);
    const w = +slot.dataset.w || pageSize.w, h = +slot.dataset.h || pageSize.h;
    box.style.left = (c.box[0] / w * 100) + "%";
    box.style.top = (c.box[3] / h * 100) + "%";
    slot.appendChild(box);
    fieldEl = box;
    for (const ev of ["mousedown", "dblclick", "wheel"]) box.addEventListener(ev, (e) => e.stopPropagation());
    const off = (e) => {
      if (fieldEl !== box) { document.removeEventListener("mousedown", off, true); document.removeEventListener("keydown", esc, true); return; }
      if (!box.contains(e.target)) closeField();
    };
    const esc = (e) => { if (e.key === "Escape" && fieldEl === box) { e.preventDefault(); closeField(); } };
    setTimeout(() => {
      document.addEventListener("mousedown", off, true);
      document.addEventListener("keydown", esc, true);
    }, 0);
  }

  // --- the debug panel (Alt+Shift+G) -------------------------------------
  // Tools to check what the live preview does:
  //   - Caret map: the caret of every character of the lines around the
  //     editor cursor (2 before, 2 after), one colour per line, and the boxes
  //     of the parts that do not map 1:1 to their glyphs; with "Whole page",
  //     of every source line on the page of the caret;
  //   - Caret: the last cursor and the answer of the engine (and how long it took);
  //   - Engine log: the messages of the browser engine (TeX Live downloads,
  //     snapshots, errors), to copy into a bug report.
  const dbg = (() => {
    const LINE_COLORS = ["#d6336c", "#1c7ed6", "#2b8a3e", "#ae3ec9", "#0c8599"];   // line -2 .. +2
    const MAX_LOG = 400;
    const logLines = [];
    let panel = null, mapOn = false, sentAt = 0;
    let wholePage = false, elementsOn = false;
    // the whole-page map and the elements: for the page of the caret and the
    // pages in view; per page its last answer and its layer
    const maps = new Map(), mapLayers = new Map(), els = new Map(), elLayers = new Map();
    const fields = new Map(), fieldsAsked = new Map();
    // what the debug shows, kept per project (also when the panel is closed)
    const debugKey = "debug:" + projectId;
    const dstate = { map: false, wholePage: false, elements: false, colorBy: "level", instant: false, predict: true,
                     show: { top: true, mid: true, leaf: true, normal: true, special: true } };
    function saveDebug() {
      dstate.map = mapOn; dstate.wholePage = wholePage; dstate.elements = elementsOn;
      chrome.storage.local.set({ [debugKey]: dstate });
    }
    let caretPage = -1;
    const timers = new Map();

    function build() {
      panel = document.createElement("div");
      panel.className = "olive-debug";
      panel.innerHTML = `
        <div class="olive-debug-head"><b>Overleaf Live · debug</b>
          <span class="olive-debug-version"></span>
          <button class="olive-debug-close" title="Close (Alt+Shift+G)">×</button></div>
        <section>
          <label><input type="checkbox" class="olive-debug-map"> Caret map</label>
          <label class="olive-debug-sub"><input type="checkbox" class="olive-debug-page"> Whole page</label>
          <div class="olive-debug-note">Marks where the caret goes for each character of the
            lines around the cursor (with <i>Whole page</i>: of all lines on the pages in view
            and the page of the caret).
            Colours: <span class="olive-debug-legend"></span>.
            Orange box: a part that does not map 1:1 to its glyphs.</div>
          <div class="olive-debug-mapinfo"></div>
        </section>
        <section>
          <label><input type="checkbox" class="olive-debug-elements"> Boxes</label>
          <div class="olive-debug-types"></div>
          <label class="olive-debug-sub">Colour by
            <select class="olive-debug-colorby"><option value="level">level</option><option value="kind">kind</option></select></label>
          <div class="olive-debug-note">On the pages in view and the page of the caret. Elements
            (TikZ pictures, paths, nodes, to[...] parts, module marks; label: kind and source line) by
            their level in the tree, or by kind (<span style="color:#c92a2a">pictures</span>,
            <span style="color:#1971c2">paths</span>, <span style="color:#2f9e44">nodes</span>,
            <span style="color:#ae3ec9">to[...]</span>, <span style="color:#e8590c">module marks</span>).
            Dashed: no source in the project. Editable (dotted, filled): what a double-click edits
            (normal: an edit box; special: a menu, a value list or a name); the engine checks every
            character of the page. The panel can close; what it shows stays, also after a reload.</div>
          <div class="olive-debug-elinfo"></div>
        </section>
        <section>
          <label><input type="checkbox" class="olive-debug-predict"> Predict the caret while typing</label>
          <div class="olive-debug-note">After a key, the caret moves at once by about one character
            width; the engine's answer then puts it in its exact place.</div>
        </section>
        <section>
          <label><input type="checkbox" class="olive-debug-instant"> Instant feedback (test)</label>
          <div class="olive-debug-note">A double-click outlines what it edits at once, and a value
            chosen in a menu shows on the page at once, before the new picture comes. It can show a
            value that the new picture does not have (for example after an error).</div>
        </section>
        <section>
          <div class="olive-debug-title">Timings</div>
          <pre class="olive-debug-timings">(no timings yet)</pre>
        </section>
        <section>
          <div class="olive-debug-title">Caret</div>
          <pre class="olive-debug-caret">(move the cursor in the editor)</pre>
        </section>
        <section>
          <div class="olive-debug-title">Engine log
            <button class="olive-debug-copy">Copy</button>
            <button class="olive-debug-clear">Clear</button></div>
          <pre class="olive-debug-log"></pre>
        </section>`;
      const q = (sel) => panel.querySelector(sel);
      q(".olive-debug-version").textContent =
        "v" + chrome.runtime.getManifest().version + " · " + (engine === "wsl" ? "WSL helper" : "browser engine");
      q(".olive-debug-close").addEventListener("click", toggle);
      q(".olive-debug-map").addEventListener("change", (e) => setMap(e.target.checked));
      q(".olive-debug-page").addEventListener("change", (e) => setWholePage(e.target.checked));
      q(".olive-debug-page").disabled = !mapOn;
      q(".olive-debug-elements").addEventListener("change", (e) => setElements(e.target.checked));
      const types = q(".olive-debug-types");
      for (const [k, name, color] of TYPES) {
        const l = document.createElement("label");
        l.className = "olive-debug-sub";
        l.innerHTML = `<input type="checkbox"> <span class="olive-debug-swatch" style="border-color:${color}"></span> ${name}`;
        const box = l.querySelector("input");
        box.checked = dstate.show[k];
        box.addEventListener("change", () => {
          dstate.show[k] = box.checked;
          saveDebug();
          if (elementsOn && (k === "normal" || k === "special") && box.checked) refresh();
          redrawBoxes();
        });
        types.appendChild(l);
      }
      q(".olive-debug-predict").checked = dstate.predict !== false;
      q(".olive-debug-predict").addEventListener("change", (e) => { dstate.predict = e.target.checked; saveDebug(); });
      q(".olive-debug-instant").checked = !!dstate.instant;
      q(".olive-debug-instant").addEventListener("change", (e) => { dstate.instant = e.target.checked; saveDebug(); });
      q(".olive-debug-colorby").value = dstate.colorBy;
      q(".olive-debug-colorby").addEventListener("change", (e) => {
        dstate.colorBy = e.target.value;
        saveDebug();
        redrawBoxes();
      });
      q(".olive-debug-map").checked = mapOn;
      q(".olive-debug-page").checked = wholePage;
      q(".olive-debug-page").disabled = !mapOn;
      q(".olive-debug-elements").checked = elementsOn;
      showTimings();
      showLegend();
      q(".olive-debug-copy").addEventListener("click", () => {
        navigator.clipboard.writeText(logLines.join("\n")).catch(() => {});
      });
      q(".olive-debug-clear").addEventListener("click", () => { logLines.length = 0; showLog(); });
      for (const ev of ["keydown", "mousedown", "wheel"]) panel.addEventListener(ev, (e) => e.stopPropagation());
      document.body.appendChild(panel);
      showLog();
    }

    // the panel opens and closes; what it shows on the pages stays
    function toggle() {
      if (!panel) build();
      else panel.hidden = !panel.hidden;
      if (!panel.hidden) { showLog(); showTimings(); }
      if (!panel.hidden) {
        panel.querySelector(".olive-debug-version").textContent =
          "v" + chrome.runtime.getManifest().version + " · " + (engine === "wsl" ? "WSL helper" : "browser engine");
      }
    }

    function showLegend() {
      panel.querySelector(".olive-debug-legend").innerHTML = wholePage
        ? "they change from line to line (" + LINE_COLORS.map((c) => `<span style="color:${c}">■</span>`).join("") + ")"
        : LINE_COLORS.map((c, k) =>
          `<span style="color:${c}">${k < 2 ? "line " + (k - 2) : k === 2 ? "cursor line" : "line +" + (k - 2)}</span>`).join(", ");
    }

    // the engine sends the map of the lines around the cursor with each
    // caret (caretDebug on); the whole page only when asked (caretMap)
    function setMap(on) {
      mapOn = on;
      saveDebug();
      if (panel) {
        panel.querySelector(".olive-debug-map").checked = on;
        panel.querySelector(".olive-debug-page").disabled = !on;
      }
      send({ type: "caretDebug", on: on && !wholePage });
      clearMap();
      if (!on) return;
      if (wholePage) refresh();
      else if (lastCursor) {
        sentAt = performance.now();
        send({ type: "cursor", seq: ++cursorSeq, ...lastCursor });
      }
    }

    function setWholePage(on) {
      wholePage = on;
      if (panel) showLegend();
      saveDebug();
      if (mapOn) setMap(true);
    }

    // the saved state (at the start), and again after a new connection
    function load() {
      chrome.storage.local.get(debugKey, (r) => {
        const d = r[debugKey];
        if (!d) return;
        Object.assign(dstate, d, { show: Object.assign(dstate.show, d.show || {}) });
        wholePage = !!d.wholePage;
        mapOn = !!d.map;
        elementsOn = !!d.elements;
        if (connected) resume();
      });
    }

    function resume() {
      clearMap();
      for (const p of [...new Set([...elLayers.keys(), ...els.keys(), ...fields.keys()])]) dropElements(p);
      send({ type: "caretDebug", on: mapOn && !wholePage });
      if ((mapOn && wholePage) || elementsOn) refresh();
      else if (mapOn && lastCursor) send({ type: "cursor", seq: ++cursorSeq, ...lastCursor });
    }

    // --- timings (debug panel) ---
    const T = { edits: [], pages: new Map(), lat: new Map() };
    function timing(m) {
      if (m.kind === "latency") {
        const l = T.lat.get(m.what) || { ms: [], extra: new Map() };
        l.ms.push(m.ms);
        if (l.ms.length > 30) l.ms.shift();
        if (m.extra) l.extra.set(m.extra, (l.extra.get(m.extra) || 0) + 1);
        l.last = m.ms;
        T.lat.set(m.what, l);
      }
      else if (m.kind === "edit") { T.edits.push(m.ms); if (T.edits.length > 20) T.edits.shift(); T.edit = m; }
      else if (m.kind === "page") T.pages.set(m.page, m);
      else T[m.kind] = m;
      if (panel && !panel.hidden) showTimings();
    }
    function showTimings() {
      if (!panel) return;
      const lines = [];
      const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
      if (T.start) {
        lines.push(`start         ${T.start.ms} ms to the first page`);
        for (const [what, ms] of T.start.parts || []) lines.push(`  ${String(ms).padStart(6)} ms  ${what}`);
      }
      if (T.edit) lines.push(`live edit     ${T.edit.ms} ms to a new page (avg ${avg(T.edits)} of ${T.edits.length})` +
        (T.edit.ticks !== undefined ? `; ${T.edit.ticks} ticks, ${T.edit.tickMs} ms in the engine` : ""));
      const pg = [...T.pages.values()];
      if (pg.length) {
        const last = pg[pg.length - 1];
        const a = (k) => (pg.reduce((x, p) => x + p[k], 0) / pg.length).toFixed(1);
        lines.push(`page picture  list ${last.list} + draw ${last.draw} + PNG ${last.png} + map ${last.map} ms (page ${last.page + 1})`);
        lines.push(`  average     list ${a("list")} + draw ${a("draw")} + PNG ${a("png")} + map ${a("map")} ms (${pg.length} pages)`);
      }
      if (T.frame) lines.push(`frames        ${T.frame.ticks} ticks/s, ${T.frame.avg} ms avg, ${T.frame.max} ms max, busy ${T.frame.busy}%`);
      else if (engine === "wsl") lines.push("frames        (browser engine only)");
      if (T.deep) lines.push(`deep          ${T.deep.ms} ms to the end of the document` +
        (T.deep.passes !== undefined ? ` (${T.deep.passes} extra pass${T.deep.passes === 1 ? "" : "es"})` : ""));
      if (T.lua) lines.push(`Lua (WSL)     ${T.lua.ms} ms for latexmk`);
      if (T.fields) lines.push(`editable      ${T.fields.ms} ms for page ${T.fields.page + 1} (${T.fields.n} boxes)`);
      if (T.lat.size) lines.push("latency (last / median of the last 30):");
      for (const [what, l] of T.lat) {
        const sorted = [...l.ms].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
        const extra = [...l.extra].map(([k, n]) => `${k} ${n}`).join(", ");
        lines.push(`  ${what}: ${what === "cache vs engine caret" ? "" : `${l.last} / ${med} ms`}${extra ? ` (${extra})` : ""}`);
      }
      panel.querySelector(".olive-debug-timings").textContent = lines.length ? lines.join("\n") : "(no timings yet)";
    }

    // the pages to show: the page of the caret and the pages in view (at most 6)
    function wanted() {
      const set = new Set();
      if (caretPage >= 0) set.add(caretPage);
      // view: the pages in view and one below
      for (let p = Math.max(0, view.first); p < view.last && set.size < 6; p++) set.add(p);
      return set;
    }

    // ask for the pages that are wanted and not here; drop the others
    function refresh() {
      const want = wanted();
      const pageMap = mapOn && wholePage;
      for (const p of [...mapLayers.keys()]) if (!pageMap || !want.has(p)) dropMap(p);
      for (const p of [...elLayers.keys()]) if (!elementsOn || !want.has(p)) dropElements(p);
      for (const p of want) {
        if (pageMap && !maps.has(p)) request("caretMap", p, 0);
        if (elementsOn && !els.has(p)) request("caretElements", p, 0);
        if (elementsOn && wantFields() && !fields.has(p)) request("pageFields", p, 0);
      }
    }

    function request(type, page, delay) {
      const key = type + page;
      clearTimeout(timers.get(key));
      if (type === "caretMap") maps.set(page, null);       // asked
      else if (type === "pageFields") fields.set(page, null);
      else els.set(page, null);
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        if (type === "pageFields") fieldsAsked.set(page, performance.now());
        send({ type, page });
      }, delay));
    }

    // a page typeset again (an edit): its map and elements again
    function pageUpdated(page) {
      if (mapOn && wholePage && maps.has(page)) request("caretMap", page, 1000);
      if (elementsOn && els.has(page)) request("caretElements", page, 1000);
      if (elementsOn && fields.has(page)) request("pageFields", page, 1500);
    }

    function viewChanged() {
      if ((mapOn && wholePage) || elementsOn) refresh();
    }

    function setElements(on) {
      elementsOn = on;
      if (panel) panel.querySelector(".olive-debug-elements").checked = on;
      clearElements();
      saveDebug();
      if (on) refresh();
    }

    function dropElements(p) {
      const l = elLayers.get(p);
      if (l) l.remove();
      elLayers.delete(p);
      els.delete(p);
      fields.delete(p);
    }

    function clearElements() {
      for (const p of [...new Set([...elLayers.keys(), ...els.keys(), ...fields.keys()])]) dropElements(p);
      if (panel) panel.querySelector(".olive-debug-elinfo").textContent = "";
    }

    // Boxes: the elements (by level in the tree of elements, or by kind) and
    // what a double-click edits (normal: an edit box; special: a module
    // marker with a menu, a value list or a name)
    const KIND_COLORS = { P: "#c92a2a", s: "#c92a2a", p: "#1971c2", n: "#2f9e44", t: "#ae3ec9",
                          L: "#1971c2", c: "#e8590c" };
    const TYPES = [
      ["top", "Top parents", "#c92a2a"], ["mid", "Intermediary", "#f08c00"],
      ["leaf", "Lowest", "#1971c2"], ["normal", "Normally editable", "#2f9e44"],
      ["special", "Specially editable", "#ae3ec9"]];
    const typeColor = Object.fromEntries(TYPES.map(([k, , c]) => [k, c]));
    const wantFields = () => dstate.show.normal || dstate.show.special;

    function elements(msg) {
      if (!elementsOn || !els.has(msg.page)) return;
      els.set(msg.page, msg);
      drawBoxes(msg.page);
    }

    function pageFields(msg) {
      if (!elementsOn || !fields.has(msg.page)) return;
      const asked = fieldsAsked.get(msg.page);
      fields.set(msg.page, { list: msg.fields, ms: asked ? Math.round(performance.now() - asked) : null });
      if (asked) timing({ kind: "fields", page: msg.page, ms: Math.round(performance.now() - asked), n: msg.fields.length });
      drawBoxes(msg.page);
    }

    // level of each element: top (no parent), lowest (no child), between
    function levels(list) {
      const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
      const inside = (a, b) => a[0] >= b[0] - 0.5 && a[1] >= b[1] - 0.5 && a[2] <= b[2] + 0.5 && a[3] <= b[3] + 0.5;
      const parent = list.map((e, i) => {
        let best = -1;
        list.forEach((o, j) => {
          if (j === i || o.depth >= e.depth || !inside(e.box, o.box)) return;
          if (best < 0 || o.depth > list[best].depth || (o.depth === list[best].depth && area(o.box) < area(list[best].box))) best = j;
        });
        return best;
      });
      const hasChild = new Set(parent.filter((p) => p >= 0));
      return list.map((e, i) => parent[i] < 0 ? "top" : hasChild.has(i) ? "mid" : "leaf");
    }

    function drawBoxes(page) {
      const msg = els.get(page), fl = fields.get(page);
      if (page >= slots().length) setSlotCount(page + 1);
      const slot = slots()[page];
      if (!slot) return;
      const old = elLayers.get(page);
      if (old) old.remove();
      const layer = document.createElement("div");
      layer.className = "olive-debug-layer";
      const counts = { top: 0, mid: 0, leaf: 0, normal: 0, special: 0 };
      let nosrc = 0;
      const files = new Set();
      if (msg) {
        const seen = new Set();
        const list = msg.elements.filter((e) => {
          if (e.box[0] < 0) return false;   // draws nothing
          // the same box twice (e.g. a picture and its only scope): one box
          const key = e.box.map((v) => v.toFixed(1)).join(",");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const lv = levels(list);
        list.forEach((e, i) => {
          const level = lv[i];
          if (!dstate.show[level]) return;
          counts[level]++;
          // no source: TeX read it from a file that is not in the project
          // (e.g. main-usage.tex, which the catalog's usage environment writes)
          const known = !!e.src[0];
          // by kind: grey when there is no source; by level: dashed only
          const color = dstate.colorBy === "level" ? typeColor[level] : known ? KIND_COLORS[e.kind] || "#555" : "#868e96";
          const b = document.createElement("div");
          b.className = "olive-debug-el" + (known ? "" : " olive-debug-el-nosrc");
          b.style.borderColor = color;
          placeBox(b, slot, e.box);
          const tag = document.createElement("span");
          tag.textContent = e.kind + (known ? e.src[0] : e.line);
          tag.style.color = color;
          b.appendChild(tag);
          layer.appendChild(b);
          if (!known) { nosrc++; files.add(e.file || "the main file"); }
        });
      }
      if (fl) for (const f of fl.list) {
        const type = f.kind === "s" ? "special" : "normal";
        if (!dstate.show[type]) continue;
        counts[type]++;
        const b = document.createElement("div");
        b.className = "olive-debug-field olive-debug-field-" + type;
        b.style.borderColor = typeColor[type];
        placeBox(b, slot, f.box);
        layer.appendChild(b);
      }
      slot.appendChild(layer);
      elLayers.set(page, layer);
      if (panel) panel.querySelector(".olive-debug-elinfo").textContent =
        `page ${page + 1}: ` + TYPES.filter(([k]) => dstate.show[k]).map(([k, name]) => `${counts[k]} ${name.toLowerCase()}`).join(", ") +
        (fl === null && wantFields() ? " (editable: computing…)" : "") +
        (nosrc ? `; ${nosrc} dashed: no source in the project (from ${[...files].join(", ")})` : "");
    }

    function redrawBoxes() {
      for (const p of elLayers.keys()) drawBoxes(p);
    }

    function dropMap(p) {
      const l = mapLayers.get(p);
      if (l) l.remove();
      mapLayers.delete(p);
      maps.delete(p);
    }

    function clearMap() {
      for (const p of [...new Set([...mapLayers.keys(), ...maps.keys()])]) dropMap(p);
      if (panel) panel.querySelector(".olive-debug-mapinfo").textContent = "";
    }

    // the line map (around the cursor) has the key -1; the page maps their page
    function map(msg) {
      if (!mapOn) return;
      if (wholePage) {
        if (!maps.has(msg.page)) return;
        maps.set(msg.page, msg);
        drawMap(msg, msg.page);
      } else {
        for (const p of [...mapLayers.keys()]) if (p !== -1) dropMap(p);
        maps.set(-1, msg);
        drawMap(msg, -1);
      }
    }

    function redraw() {
      for (const [key, msg] of maps) if (msg) drawMap(msg, key);
    }

    function drawMap(msg, key) {
      if (!msg || !settings.on) return;
      if (msg.page >= slots().length) setSlotCount(msg.page + 1);
      const slot = slots()[msg.page];
      if (!slot) return;
      const old = mapLayers.get(key);
      if (old) old.remove();
      const layer = document.createElement("div");
      layer.className = "olive-debug-layer";
      const w = +slot.dataset.w || pageSize.w, h = +slot.dataset.h || pageSize.h;
      const lines = [...new Set(msg.points.map((p) => p[0]))].sort((a, b) => a - b);
      const cur = lastCursor ? lastCursor.line : lines[Math.floor(lines.length / 2)] || 0;
      const counts = {};
      for (const [line, col, x, y, ph, pd] of msg.points) {
        const k = wholePage ? ((line % 5) + 5) % 5 : Math.max(-2, Math.min(2, line - cur)) + 2;
        const t = document.createElement("div");
        t.className = "olive-debug-tick";
        t.style.left = (x / w * 100) + "%";
        t.style.top = ((y - ph) / h * 100) + "%";
        t.style.height = (Math.max(ph + pd, 4) / h * 100) + "%";
        t.style.background = LINE_COLORS[k];
        layer.appendChild(t);
        counts[line] = (counts[line] || 0) + 1;
      }
      for (const b of msg.boxes) {
        const e = document.createElement("div");
        e.className = "olive-debug-box";
        placeBox(e, slot, b);
        layer.appendChild(e);
      }
      slot.appendChild(layer);
      mapLayers.set(key, layer);
      const boxes = msg.boxes.length ? `; ${msg.boxes.length} box${msg.boxes.length > 1 ? "es" : ""}` : "";
      if (panel) panel.querySelector(".olive-debug-mapinfo").textContent = wholePage
        ? `page ${msg.page + 1}: ${msg.points.length} positions on ${lines.length} source lines${boxes}`
        : `page ${msg.page + 1}: ` + Object.entries(counts).map(([l, n]) => `line ${l}: ${n} positions`).join(", ") + boxes;
    }

    function cursor(c) { sentAt = performance.now(); }

    function caret(msg) {
      if (msg.h + msg.d > 0.5 && msg.page !== caretPage) {
        caretPage = msg.page;
        if ((mapOn && wholePage) || elementsOn) refresh();
      }
      if (!panel) return;
      const ms = sentAt ? Math.round(performance.now() - sentAt) : null;
      sentAt = 0;
      const c = lastCursor;
      const f = (v) => (+v).toFixed(2);
      let text = c ? `cursor  ${c.path} line ${c.line}, column ${c.column}\n` : "";
      if (!(msg.h + msg.d > 0.5)) text += "caret   no position (the line typesets no text)";
      else text += `caret   page ${msg.page + 1}, x ${f(msg.x)}, baseline ${f(msg.y)}, height ${f(msg.h)}, depth ${f(msg.d)} pt`;
      if (msg.box) text += `\nbox     ${msg.box.map(f).join(" ")} pt`;
      if (ms !== null) text += `\nanswer  ${ms} ms`;
      panel.querySelector(".olive-debug-caret").textContent = text;
    }

    function log(text) {
      const t = new Date().toTimeString().slice(0, 8);
      logLines.push(`${t} ${text}`);
      if (logLines.length > MAX_LOG) logLines.splice(0, logLines.length - MAX_LOG);
      if (panel && !panel.hidden) showLog();
    }

    function showLog() {
      const el = panel.querySelector(".olive-debug-log");
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      el.textContent = logLines.length ? logLines.join("\n")
        : engine === "wsl" ? "(the WSL helper writes its log in its own terminal)" : "(no messages yet)";
      if (atEnd) el.scrollTop = el.scrollHeight;
    }

    window.addEventListener("keydown", (e) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyG") {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    }, true);

    load();
    return { map, elements, pageFields, timing, resume, caret, cursor, log, clearMap, clearElements, pageUpdated,
      redraw, view: viewChanged,
      get lineMapOn() { return mapOn && !wholePage; },
      get instant() { return !!dstate.instant; },
      get predict() { return dstate.predict !== false; } };
  })();

  // --- connection ---------------------------------------------------
  function send(msg) {
    if (port && connected) port.postMessage(msg);
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "overleaf-live" });
    } catch (e) {
      // the extension was reloaded (updated): this page has the old copy
      setStatus("Overleaf Live was updated: reload this page", false);
      port = null;
      return;
    }
    setStatus(engine === "wsl" ? "connecting to the helper…" : "starting the engine…", true);
    port.onMessage.addListener(onHelper);
    port.onDisconnect.addListener(() => {
      port = null;
      connected = false;
      showStatus();
      if (settings.on) setTimeout(connect, 1000);   // the service worker restarted
    });
  }

  function disconnect() {
    if (port) port.disconnect();
    port = null;
    connected = false;
  }

  function startSession() {
    lastText.clear();
    send({ type: "hello", project: projectId, main: settings.main, lua: settings.lua });
    dbg.resume();
    view = { first: -1, last: -1 };
    sendWidth();
    checkView();
    // the editor tab sends the files; the PDF tab only when asked (Sync)
    if (!detached) sync(true);
  }

  function onHelper(msg) {
    switch (msg.type) {
      case "connected":
        connected = true;
        setStatus("connected", false);
        startSession();
        break;
      case "disconnected":
        connected = false;
        setStatus(engine === "wsl" ? "helper not running (start it in WSL)" : "engine not running", false);
        break;
      case "status":
        setStatus(msg.text, msg.busy);
        break;
      case "notReady":
        clickNotReady(msg.page);
        break;
      case "page": {
        setTimeout(() => pageArrived(msg.page), 0);
        pageCount = Math.max(msg.count, msg.page + 1);
        done = msg.done;
        const size = { w: msg.w || pageSize.w, h: msg.h || pageSize.h };
        if (msg.page === 0 && (size.w !== pageSize.w || size.h !== pageSize.h)) {
          pageSize = size;
          applyZoom();
        }
        updateSlots();
        dbg.pageUpdated(msg.page);
        pageChanged(msg.page);
        if (msg.page >= view.first && msg.page <= view.last) {
          clearTimeout(workTimer);
          workTimer = setTimeout(endWork, 300);   // more pages in view may follow
        }
        const slot = slots()[msg.page];
        if (slot) {
          // (a new size only: keepScroll reads the layout)
          if (+slot.dataset.w !== size.w || +slot.dataset.h !== size.h) keepScroll(() => sizeSlot(slot, size));
          showImage(slot, "data:image/png;base64," + msg.png);
          slot.classList.add("olive-loaded");
        }
        if (!status.busy && status.text !== "live") setStatus("live", false);
        break;
      }
      case "count":
        pageCount = msg.count;
        done = msg.done;
        updateSlots();
        break;
      case "errors":
        errors = msg.lines;
        showStatus();
        showErrors(msg.items || msg.lines.map((t) => ({ text: t, file: null, line: 0 })));
        break;
      case "caret":
        // an answer for an older cursor (the newer one is on its way): not shown
        if (msg.seq !== undefined && msg.seq < cursorSeq) break;
        clearTimeout(caretTimer);
        dbg.caret(msg);
        if (!(msg.h + msg.d > 0.5)) {
          // the line typesets no text (e.g. \begin{figure}): no position
          caretEl.classList.add("olive-caret-stale");
          caretBox.remove();
          break;
        }
        // the cached caret and the engine's: the same? (debug panel)
        if (caret && caret.cached && caret.page === msg.page)
          latency("cache vs engine caret", 0, Math.hypot(caret.x - msg.x, caret.y - msg.y) < 1 ? "same" : "different");
        if (caret && caret.predicted && caret.page === msg.page)
          latency("predicted vs engine caret", 0, Math.hypot(caret.x - msg.x, caret.y - msg.y) < 1.5 ? "same" : "different");
        caret = msg;
        placeCaret(Date.now() - lastCursorMove < 3000);
        setPredBase(msg);
        if (cursorAt) {
          latency("cursor → caret", performance.now() - cursorAt, cursorCached ? "cache, then engine" : "engine");
          cursorAt = 0;
        }
        break;
      case "caretDebug":
        dbg.map(msg);
        break;
      case "caretElements":
        dbg.elements(msg);
        break;
      case "pageFields":
        dbg.pageFields(msg);
        break;
      case "timing":
        dbg.timing(msg);
        break;
      case "debug":
        dbg.log(msg.text);
        break;
      case "field":
        pendingField = msg;
        break;
      case "pageMap":
        onPageMap(msg);
        break;
      case "probe":
        onProbe(msg);
        break;
      case "pageCache":
        onPageCache(msg);
        break;
      case "dest":
        onDest(msg);
        break;
      case "choice":
        pendingField = null;
        openChoice(msg);
        break;
      case "apply":
        // a change made at once (a K-map cell toggled): page.js checks that
        // the source is still the same
        whenOpen(msg.path, msg.from[0], msg.from[1], (id) =>
          window.postMessage({ [TAG + "Cmd"]: "replace", docId: id, line: msg.from[0], column: msg.from[1],
            toLine: msg.to[0], toColumn: msg.to[1], expect: msg.old, text: msg.text }, location.origin));
        break;
      case "goto": {
        // a field: select it in the editor, and open the edit box on the page
        const f = pendingField;
        pendingField = null;
        if (f && f.path === msg.path && f.from[0] === msg.line && f.from[1] === msg.column) {
          // the editor selects the field (in a command call on one line: only
          // the clicked argument of it)
          const one = f.sel && f.from[0] === f.to[0];
          gotoSource({ ...msg, column: one ? f.from[1] + f.sel[0] : f.from[1],
                       toLine: f.to[0], toColumn: one ? f.from[1] + f.sel[1] : f.to[1] });
          // a field that shows in several places (e.g. \autoterms[0] in all
          // K-map cells): an edit would change all of them, so no edit box
          // (in a file that is not open: when Overleaf has opened it, else the
          // editor takes the focus from the box at once)
          if (f.shared) setStatus("this value shows in several places: change it in the editor", false);
          else if (docId && pathOf(docId) === f.path) openField(f);
          else afterOpen = { path: f.path, run: () => openField(f) };
        } else {
          gotoSource(msg);
        }
        break;
      }
    }
  }

  function setOn(on) {
    settings.on = on;
    save();
    apply();
  }

  // turn the viewer and the connection on or off (also when another tab of
  // this project changed the setting)
  function apply() {
    const was = !pane.hidden;
    pane.hidden = !settings.on;
    $(".olive-lua").checked = engine === "wsl" ? settings.lua : true;
    if (settings.on && !port) connect();
    if (!settings.on) {
      disconnect();
      menu.hidden = true;
      caret = null;
      caretEl.remove();
      caretBox.remove();
      dbg.clearMap();
      dbg.clearElements();
      if (was) restoreToolbar();
    }
    if (settings.on) { applyZoom(); checkView(); }
    showStatus();
  }

  // --- project files --------------------------------------------------
  // The zip download is limited by Overleaf (10 a minute): at most one
  // every 10 seconds; a later request waits.
  function sync(now) {
    if (!connected) return;
    const wait = lastSync + 10000 - Date.now();
    if (wait > 0) {
      if (!syncTimer) syncTimer = setTimeout(() => { syncTimer = null; sync(true); }, wait);
      return;
    }
    lastSync = Date.now();
    setStatus("sending project files…", true);
    fetch(`/Project/${projectId}/download/zip`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then((buf) => {
        send({ type: "project", zip: toBase64(new Uint8Array(buf)) });
        // the open file in the zip may be older than the editor: send it again
        lastText.clear();
        window.postMessage({ [TAG + "Cmd"]: "resend" }, location.origin);
      })
      .catch((e) => setStatus("could not get the project files: " + e.message, false));
  }

  function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Overleaf's id for a file -> its path, from the file tree
  function pathOf(id) {
    const entity = document.querySelector(`[data-file-id="${CSS.escape(id)}"]`);
    if (!entity) return null;
    // A folder's contents are a list placed right after the folder's own
    // item (not inside it): <li folder> <ul role=tree> ...items... </ul>
    const parts = [];
    let item = entity.closest('li[role="treeitem"]');
    while (item) {
      const name = item.getAttribute("aria-label");
      if (!name) return null;
      parts.unshift(name);
      const list = item.closest('ul[role="tree"]');
      const prev = list && list.previousElementSibling;
      item = prev && prev.matches('li[role="treeitem"]') ? prev : null;
    }
    return parts.length ? parts.join("/") : null;
  }

  // --- edits from page.js -------------------------------------------
  window.addEventListener("message", (evt) => {
    if (evt.source !== window || !evt.data || !evt.data[TAG]) return;
    const msg = evt.data;
    if (msg.kind === "opened") {
      if (docId && msg.docId !== docId && settings.on) sync(false);  // other files may have changed
      docId = msg.docId;
      if (pendingGoto && pendingGoto.docId === docId) {
        const cmd = pendingGoto;
        pendingGoto = null;
        setTimeout(() => window.postMessage(cmd, location.origin), 150);
      }
      if (afterOpen && pathOf(docId) === afterOpen.path) {
        const run = afterOpen.run;
        afterOpen = null;
        setTimeout(run, 600);   // after the goto, when the editor has the focus
      }
      return;
    }
    if (msg.kind === "inserted") {
      if (msg.usemodule === "elsewhere")
        setStatus(`inserted; add ${msg.module} to \\usemodule{...} in the main file`, false);
      return;
    }
    if (msg.kind === "replaced" && msg.id === "modbar") {
      if (!msg.ok) modFormError(`not changed: ${msg.why}`);
      else closeModForm();
      return;
    }
    if (msg.kind === "replaced") {
      if (!msg.ok) setStatus(`quick edit not saved: ${msg.why}`, false);
      return;
    }
    if (msg.kind === "bbl") {
      // Overleaf's .bbl (Biber): the browser engine uses it for biblatex
      if (settings.on && connected && typeof msg.text === "string") send({ type: "file", path: "output.bbl", text: msg.text });
      return;
    }
    if (msg.kind === "cursor") {
      if (!settings.on || !connected) return;
      const path = pathOf(msg.docId);
      if (!path || !/\.(tex|ltx|sty|cls)$/i.test(path)) return;
      lastCursorMove = Date.now();
      lastCursor = { path, line: msg.line, column: msg.column };
      dbg.cursor(lastCursor);
      send({ type: "cursor", seq: ++cursorSeq, path, line: msg.line, column: msg.column });
      // the caret at once from the cache (the engine's answer corrects it)
      const cached = cachedCaret(path, msg.line, msg.column);
      cursorCached = !!cached;
      if (cached) {
        caret = Object.assign(cached, { cached: true });
        placeCaret(true);
        setPredBase(caret);
        latency("cursor → caret (cache)", performance.now() - (msg.t || performance.now()));
        cursorAt = 0;
      } else {
        cursorAt = msg.t || performance.now();
        // while typing: the predicted caret (the engine's answer replaces it)
        const pred = dbg.predict ? predictCaret(path, msg.line, msg.column) : null;
        if (pred) {
          caret = pred;
          placeCaret(true);
          latency("cursor → caret (predicted)", performance.now() - (msg.t || performance.now()));
        }
      }
      updateModBar();
      // no answer: the cursor is in text that is not on a page (yet)
      clearTimeout(caretTimer);
      caretTimer = setTimeout(() => caretEl.classList.add("olive-caret-stale"), 1500);
      return;
    }
    if (msg.kind !== "doc" || !settings.on || !connected) return;
    const path = pathOf(msg.docId);
    if (!path) {
      setStatus("can't find this file in the file tree", false);
      return;
    }
    if (lastText.get(path) === msg.text) return;
    lastText.set(path, msg.text);
    send({ type: "edit", path, text: msg.text });
    if (!editAt && document.querySelector(".olive-slot img")) editAt = msg.t || performance.now();
    dropAllCaches();
    scheduleCache(800);
    startWork();
  });

  // --- settings per project (shared by the editor tab and the PDF tab) ----
  function save() {
    chrome.storage.local.set({ [settingsKey]: settings });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.engine) {
      engine = changes.engine.newValue === "wsl" ? "wsl" : "browser";
      if (settings.on) { disconnect(); connect(); }
      showStatus();
    }
    if (area !== "local" || !changes[settingsKey]) return;
    const next = changes[settingsKey].newValue || {};
    const turned = next.on !== settings.on;
    const luaChanged = next.lua !== settings.lua;
    settings = Object.assign(settings, next);
    if (turned) apply();
    else if (luaChanged) $(".olive-lua").checked = engine === "wsl" ? settings.lua : true;
  });

  chrome.storage.local.get([settingsKey, "engine"], (r) => {
    engine = r.engine === "wsl" ? "wsl" : "browser";
    settings = Object.assign(settings, r[settingsKey] || {});
    if (!settings.zoom || !settings.zoom.mode) settings.zoom = { mode: "page-width", scale: 1 };
    apply();
  });
})();
