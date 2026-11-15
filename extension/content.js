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
  let docId = null;              // the file open in the editor (Overleaf's id)
  let engine = "browser";        // "browser" (WebAssembly) or "wsl" (the helper); for all projects

  // --- the viewer and the Live button ---------------------------------
  const ui = document.createElement("div");
  ui.className = "olive-root";
  ui.innerHTML = `
    <div class="olive-pane" hidden>
      <div class="olive-scroll" tabindex="0"><div class="olive-pages"></div></div>
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
    const cmd = { [TAG + "Cmd"]: "goto", line: msg.line, column: msg.column };
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

  // Ctrl + wheel and Overleaf's keyboard shortcuts, on the live pages
  scroller.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom("scale", scale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
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
    let panel = null, mapOn = false, mapLayer = null, sentAt = 0, lastMap = null;
    let wholePage = false, mapPage = -1, pageTimer = null;

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
            lines around the cursor (with <i>Whole page</i>: of all lines on the page of the caret).
            Colours: <span class="olive-debug-legend"></span>.
            Orange box: a part that does not map 1:1 to its glyphs.</div>
          <div class="olive-debug-mapinfo"></div>
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
      if (wholePage) requestPage(caret ? caret.page : -1, 0);
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

    // the map of a page: again when the caret goes to another page, and
    // after the page was typeset again (an edit)
    function requestPage(page, delay) {
      clearTimeout(pageTimer);
      if (!mapOn || !wholePage || page < 0) return;
      pageTimer = setTimeout(() => {
        mapPage = page;
        send({ type: "caretMap", page });
      }, delay);
    }

    function pageUpdated(page) {
      if (mapOn && wholePage && page === mapPage) requestPage(page, 1000);
    }

    function clearMap() {
      if (mapLayer) mapLayer.remove();
      mapLayer = null;
      lastMap = null;
      mapPage = -1;
      if (panel) panel.querySelector(".olive-debug-mapinfo").textContent = "";
    }

    function map(msg) {
      if (!mapOn) return;
      lastMap = msg;
      drawMap();
    }

    function drawMap() {
      const msg = lastMap;
      if (!msg || !settings.on) return;
      if (msg.page >= slots().length) setSlotCount(msg.page + 1);
      const slot = slots()[msg.page];
      if (!slot) return;
      if (mapLayer) mapLayer.remove();
      mapLayer = document.createElement("div");
      mapLayer.className = "olive-debug-layer";
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
        mapLayer.appendChild(t);
        counts[line] = (counts[line] || 0) + 1;
      }
      for (const b of msg.boxes) {
        const e = document.createElement("div");
        e.className = "olive-debug-box";
        placeBox(e, slot, b);
        mapLayer.appendChild(e);
      }
      slot.appendChild(mapLayer);
      const boxes = msg.boxes.length ? `; ${msg.boxes.length} box${msg.boxes.length > 1 ? "es" : ""}` : "";
      if (panel) panel.querySelector(".olive-debug-mapinfo").textContent = wholePage
        ? `page ${msg.page + 1}: ${msg.points.length} positions on ${lines.length} source lines${boxes}`
        : `page ${msg.page + 1}: ` + Object.entries(counts).map(([l, n]) => `line ${l}: ${n} positions`).join(", ") + boxes;
    }

    function cursor(c) { sentAt = performance.now(); }

    function caret(msg) {
      if (mapOn && wholePage && msg.h + msg.d > 0.5 && msg.page !== mapPage) requestPage(msg.page, 0);
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

    return { map, caret, cursor, log, clearMap, pageUpdated, redraw: drawMap,
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
        const slot = slots()[msg.page];
        if (slot) {
          sizeSlot(slot, size);
          slot.firstChild.src = "data:image/png;base64," + msg.png;
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
      case "debug":
        dbg.log(msg.text);
        break;
      case "goto":
        gotoSource(msg);
        break;
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
