// content.js -- the extension's part of the Overleaf page: the "Live"
// button and viewer over Overleaf's PDF pane, the project upload, and the
// edits from page.js, all sent to the local helper through background.js.
(() => {
  const TAG = "__overleafLive";
  const projectId = (location.pathname.match(/^\/project\/([0-9a-f]{24})/) || [])[1];
  if (!projectId) return;

  const settingsKey = "project:" + projectId;
  let settings = { on: false, lua: false, main: "" };
  let port = null;
  let connected = false;
  let docId = null;
  let lastText = new Map();     // path -> text last sent
  let pageCount = 0;           // pages typeset so far
  let done = false;            // true: the document is finished, pageCount is all
  let knownTotal = 0;          // pages when the document was last finished
  let zoom = 1;                // 1: page width = pane width
  let view = { first: -1, last: -1 };   // visible pages last sent
  let lastSync = 0;
  let syncTimer = null;
  let widthTimer = null;

  // --- UI -------------------------------------------------------------
  const ui = document.createElement("div");
  ui.className = "olive-root";
  ui.innerHTML = `
    <button class="olive-toggle" title="Live preview by TeXpresso on your PC">Live</button>
    <div class="olive-pane" hidden>
      <div class="olive-bar">
        <button class="olive-prev" title="Previous page">&lsaquo;</button>
        <span class="olive-page">–</span>
        <button class="olive-next" title="Next page">&rsaquo;</button>
        <button class="olive-zoomout" title="Zoom out (Ctrl + wheel)">&minus;</button>
        <button class="olive-fit" title="Fit width">Fit</button>
        <button class="olive-zoomin" title="Zoom in (Ctrl + wheel)">+</button>
        <span class="olive-status">not connected</span>
        <span class="olive-spacer"></span>
        <label title="Runs a normal XeLaTeX compile with shell escape on your PC for calc/fsm results. Shell escape can run any command: turn on only for projects you trust.">
          <input type="checkbox" class="olive-lua"> Lua</label>
        <button class="olive-sync" title="Send all project files again">Sync</button>
      </div>
      <div class="olive-errors" hidden></div>
      <div class="olive-scroll" tabindex="0"><div class="olive-pages"></div></div>
    </div>`;
  const $ = (sel) => ui.querySelector(sel);
  const pane = $(".olive-pane"), scroller = $(".olive-scroll"), pages = $(".olive-pages");

  function setStatus(text, busy) {
    $(".olive-status").textContent = text;
    $(".olive-status").classList.toggle("olive-busy", !!busy);
  }

  // One slot per page, one under the other as in Overleaf. While the
  // document isn't finished, one more empty slot: when it comes into view,
  // TeXpresso typesets the next page.
  function slots() { return pages.children; }

  function setSlotCount(n) {
    while (slots().length < n) {
      const slot = document.createElement("div");
      slot.className = "olive-slot";
      slot.appendChild(document.createElement("img"));
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
    showPageNumber();
    checkView();
  }

  function slotWidth() {
    return Math.max(100, Math.round((scroller.clientWidth - 24) * zoom));
  }

  function applyZoom() {
    pages.style.width = slotWidth() + "px";
    $(".olive-fit").classList.toggle("olive-on", zoom === 1);
    sendWidth();
  }

  // the first and last page in view
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

  function showPageNumber() {
    // while TeXpresso typesets again after an edit, show the last total
    const total = done ? pageCount : Math.max(pageCount, knownTotal);
    const more = !done && pageCount >= knownTotal;
    const n = Math.min(currentPage() + 1, Math.max(total, 1));
    $(".olive-page").textContent = `${n} / ${total}${more ? "+" : ""}`;
  }

  // tell the helper which pages are in view (plus one below, so that
  // scrolling down shows a finished page)
  let viewFrame = 0;
  function checkView() {
    if (viewFrame) return;
    viewFrame = requestAnimationFrame(() => {
      viewFrame = 0;
      if (pane.hidden) return;
      const r = visibleRange();
      r.last += 1;
      if (r.first !== view.first || r.last !== view.last) {
        view = r;
        send({ type: "view", first: r.first, last: r.last });
      }
      showPageNumber();
    });
  }
  scroller.addEventListener("scroll", checkView, { passive: true });

  function gotoPage(n) {
    if (n < 0 || n >= slots().length) return;
    scroller.scrollTo({ top: slots()[n].offsetTop - 8 });
  }

  // zoom around the middle of the view
  function setZoom(z) {
    z = Math.min(4, Math.max(0.3, z));
    if (z === zoom) return;
    const mid = (scroller.scrollTop + scroller.clientHeight / 2) / (scroller.scrollHeight || 1);
    zoom = z;
    applyZoom();
    scroller.scrollTop = mid * scroller.scrollHeight - scroller.clientHeight / 2;
    checkView();
  }

  // Overleaf redraws its panes; put the UI back when it disappears
  function attach() {
    const host = document.querySelector(".pdf-viewer");
    if (host && ui.parentElement !== host) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.appendChild(ui);
      applyZoom();
    }
  }
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
  attach();

  $(".olive-toggle").addEventListener("click", () => setOn(!settings.on));
  $(".olive-prev").addEventListener("click", () => gotoPage(currentPage() - 1));
  $(".olive-next").addEventListener("click", () => gotoPage(currentPage() + 1));
  $(".olive-zoomin").addEventListener("click", () => setZoom(zoom * 1.25));
  $(".olive-zoomout").addEventListener("click", () => setZoom(zoom / 1.25));
  $(".olive-fit").addEventListener("click", () => setZoom(1));
  scroller.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  $(".olive-sync").addEventListener("click", () => sync(true));
  $(".olive-lua").addEventListener("change", (e) => {
    settings.lua = e.target.checked;
    save();
    send({ type: "lua", on: settings.lua });
  });

  // pictures are made for the page width on screen (sharp on HiDPI)
  function sendWidth() {
    clearTimeout(widthTimer);
    widthTimer = setTimeout(() => {
      const w = Math.min(4000, Math.round(slotWidth() * (window.devicePixelRatio || 1)));
      send({ type: "width", width: w });
    }, 150);
  }
  new ResizeObserver(() => { applyZoom(); checkView(); }).observe(scroller);

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
    setStatus("connecting to the helper…", true);
    port.onMessage.addListener(onHelper);
    port.onDisconnect.addListener(() => {
      port = null;
      connected = false;
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
    sendWidth();
    view = { first: -1, last: -1 };
    checkView();
    sync(true);
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
        setStatus("helper not running (start it in WSL)", false);
        break;
      case "status":
        setStatus(msg.text, msg.busy);
        break;
      case "page":
        pageCount = Math.max(msg.count, msg.page + 1);
        done = msg.done;
        updateSlots();
        if (slots()[msg.page]) {
          const img = slots()[msg.page].firstChild;
          img.src = "data:image/png;base64," + msg.png;
          slots()[msg.page].classList.add("olive-loaded");
        }
        if (!$(".olive-status").classList.contains("olive-busy")) setStatus("live", false);
        break;
      case "count":
        pageCount = msg.count;
        done = msg.done;
        updateSlots();
        break;
      case "errors": {
        const box = $(".olive-errors");
        box.hidden = !msg.lines.length;
        box.textContent = msg.lines.map((l) => "! " + l).join("\n");
        break;
      }
    }
  }

  function setOn(on) {
    settings.on = on;
    save();
    pane.hidden = !on;
    $(".olive-toggle").classList.toggle("olive-active", on);
    if (on) { connect(); applyZoom(); }
    else disconnect();
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

  // --- settings per project -------------------------------------------
  function save() {
    chrome.storage.local.set({ [settingsKey]: settings });
  }

  chrome.storage.local.get(settingsKey, (r) => {
    settings = Object.assign(settings, r[settingsKey] || {});
    $(".olive-lua").checked = settings.lua;
    if (settings.on) setOn(true);
  });
})();
