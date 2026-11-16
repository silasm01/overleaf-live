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
    });
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
    // start the blink again, as an editor caret does after a move
    caretEl.style.animation = "none";
    void caretEl.offsetWidth;
    caretEl.style.animation = "";
    if (follow) followCaret();
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
    send({ type: "scan", page: index, x, y });
  });

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
        try { dbg.view(); } catch (e) { /* not set up yet */ }
      }
      writeToolbar();
    });
  }
  scroller.addEventListener("scroll", checkView, { passive: true });

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
    return list && list.find((e) => inBox(e.box, pt.x, pt.y, 0.5));
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
    lastProbe = { page: pt.page, x: pt.x, y: pt.y };
    send({ type: "probe", page: pt.page, x: pt.x, y: pt.y });
    // no answer (an old engine): free again
    setTimeout(() => { probeBusy = false; }, 1500);
  }

  function onProbe(msg) {
    probeBusy = false;
    const b = msg.box;
    if ((msg.kind === "field" || msg.kind === "choice") && b[2] > b[0] && b[3] > b[1]) {
      const list = editable.get(msg.page) || [];
      if (!list.some((e) => e.box.join() === b.join())) list.push({ box: b, kind: msg.kind });
      editable.set(msg.page, list);
    }
    if (probeNext) { const p = probeNext; probeNext = null; probe(p); }
    else if (hoverPt && hoverPt.page === msg.page) hover(hoverPt);
  }

  // a page changed: its map and its editable boxes are old
  function pageChanged(page) {
    editable.delete(page);
    if (lastProbe && lastProbe.page === page) lastProbe = null;
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
    send({ type: "click", page: d.pt.page, x: d.pt.x, y: d.pt.y });
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
          <label><input type="checkbox" class="olive-debug-elements"> Elements (TikZ)</label>
          <div class="olive-debug-note">Boxes of the TikZ elements on the pages in view and the page of the caret:
            <span style="color:#c92a2a">pictures</span>, <span style="color:#1971c2">paths</span>,
            <span style="color:#2f9e44">nodes</span>, <span style="color:#ae3ec9">to[...] parts</span>
            and <span style="color:#e8590c">module marks</span>.
            The label is the source line.</div>
          <div class="olive-debug-elinfo"></div>
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
      showLegend();
      q(".olive-debug-copy").addEventListener("click", () => {
        navigator.clipboard.writeText(logLines.join("\n")).catch(() => {});
      });
      q(".olive-debug-clear").addEventListener("click", () => { logLines.length = 0; showLog(); });
      for (const ev of ["keydown", "mousedown", "wheel"]) panel.addEventListener(ev, (e) => e.stopPropagation());
      document.body.appendChild(panel);
      showLog();
    }

    function toggle() {
      if (!panel) build();
      else panel.hidden = !panel.hidden;
      if (panel.hidden && mapOn) setMap(false);
      if (panel.hidden && elementsOn) setElements(false);
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
        send({ type: "cursor", ...lastCursor });
      }
    }

    function setWholePage(on) {
      wholePage = on;
      if (panel) showLegend();
      if (mapOn) setMap(true);
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
      }
    }

    function request(type, page, delay) {
      const key = type + page;
      clearTimeout(timers.get(key));
      if (type === "caretMap") maps.set(page, null);       // asked
      else els.set(page, null);
      timers.set(key, setTimeout(() => { timers.delete(key); send({ type, page }); }, delay));
    }

    // a page typeset again (an edit): its map and elements again
    function pageUpdated(page) {
      if (mapOn && wholePage && maps.has(page)) request("caretMap", page, 1000);
      if (elementsOn && els.has(page)) request("caretElements", page, 1000);
    }

    function viewChanged() {
      if ((mapOn && wholePage) || elementsOn) refresh();
    }

    function setElements(on) {
      elementsOn = on;
      if (panel) panel.querySelector(".olive-debug-elements").checked = on;
      clearElements();
      if (on) refresh();
    }

    function dropElements(p) {
      const l = elLayers.get(p);
      if (l) l.remove();
      elLayers.delete(p);
      els.delete(p);
    }

    function clearElements() {
      for (const p of [...new Set([...elLayers.keys(), ...els.keys()])]) dropElements(p);
      if (panel) panel.querySelector(".olive-debug-elinfo").textContent = "";
    }

    const KIND_COLORS = { P: "#c92a2a", s: "#c92a2a", p: "#1971c2", n: "#2f9e44", t: "#ae3ec9",
                          L: "#1971c2", c: "#e8590c" };
    function elements(msg) {
      if (!elementsOn || !els.has(msg.page)) return;
      els.set(msg.page, msg);
      if (msg.page >= slots().length) setSlotCount(msg.page + 1);
      const slot = slots()[msg.page];
      if (!slot) return;
      const old = elLayers.get(msg.page);
      if (old) old.remove();
      const layer = document.createElement("div");
      layer.className = "olive-debug-layer";
      let shown = 0;
      const seen = new Set();
      let nosrc = 0;
      const files = new Set();
      for (const e of msg.elements) {
        if (e.box[0] < 0) continue;   // draws nothing
        const key = e.box.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        // no source: TeX read it from a file that is not in the project
        // (e.g. main-usage.tex, which the catalog's usage environment writes)
        const known = !!e.src[0];
        const color = known ? KIND_COLORS[e.kind] || "#555" : "#868e96";
        const b = document.createElement("div");
        b.className = "olive-debug-el" + (known ? "" : " olive-debug-el-nosrc");
        b.style.borderColor = color;
        placeBox(b, slot, e.box);
        const tag = document.createElement("span");
        tag.textContent = e.kind + (known ? e.src[0] : e.line);
        tag.style.color = color;
        b.appendChild(tag);
        layer.appendChild(b);
        shown++;
        if (!known) { nosrc++; files.add(e.file || "the main file"); }
      }
      slot.appendChild(layer);
      elLayers.set(msg.page, layer);
      if (panel) panel.querySelector(".olive-debug-elinfo").textContent =
        `page ${msg.page + 1}: ${shown} element box${shown === 1 ? "" : "es"}` +
        (nosrc ? `; ${nosrc} grey: no source in the project (from ${[...files].join(", ")}), so the cursor cannot show them` : "");
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

    return { map, elements, caret, cursor, log, clearMap, clearElements, pageUpdated, redraw, view: viewChanged,
      get lineMapOn() { return mapOn && !wholePage; } };
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
    if (dbg.lineMapOn) send({ type: "caretDebug", on: true });
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
      case "page": {
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
          keepScroll(() => sizeSlot(slot, size));
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
        clearTimeout(caretTimer);
        dbg.caret(msg);
        if (!(msg.h + msg.d > 0.5)) {
          // the line typesets no text (e.g. \begin{figure}): no position
          caretEl.classList.add("olive-caret-stale");
          caretBox.remove();
          break;
        }
        caret = msg;
        placeCaret(Date.now() - lastCursorMove < 3000);
        break;
      case "caretDebug":
        dbg.map(msg);
        break;
      case "caretElements":
        dbg.elements(msg);
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
      send({ type: "cursor", path, line: msg.line, column: msg.column });
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
