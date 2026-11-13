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
  let page = 0;
  let pageCount = 0;
  let done = false;
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
        <button class="olive-prev" title="Previous page (Page Up)">&lsaquo;</button>
        <span class="olive-page">–</span>
        <button class="olive-next" title="Next page (Page Down)">&rsaquo;</button>
        <span class="olive-status">not connected</span>
        <span class="olive-spacer"></span>
        <label title="Runs a normal XeLaTeX compile with shell escape on your PC for calc/fsm results. Shell escape can run any command: turn on only for projects you trust.">
          <input type="checkbox" class="olive-lua"> Lua</label>
        <button class="olive-sync" title="Send all project files again">Sync</button>
      </div>
      <div class="olive-errors" hidden></div>
      <div class="olive-scroll"><img class="olive-img" alt=""></div>
    </div>`;
  const $ = (sel) => ui.querySelector(sel);
  const pane = $(".olive-pane"), img = $(".olive-img"), scroller = $(".olive-scroll");

  function setStatus(text, busy) {
    $(".olive-status").textContent = text;
    $(".olive-status").classList.toggle("olive-busy", !!busy);
  }

  function showPageNumber() {
    $(".olive-page").textContent = `${page + 1} / ${pageCount}${done ? "" : "+"}`;
  }

  // Overleaf redraws its panes; put the UI back when it disappears
  function attach() {
    const host = document.querySelector(".pdf-viewer");
    if (host && ui.parentElement !== host) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.appendChild(ui);
      sendWidth();
    }
  }
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
  attach();

  $(".olive-toggle").addEventListener("click", () => setOn(!settings.on));
  $(".olive-prev").addEventListener("click", () => gotoPage(page - 1));
  $(".olive-next").addEventListener("click", () => gotoPage(page + 1));
  $(".olive-sync").addEventListener("click", () => sync(true));
  $(".olive-lua").addEventListener("change", (e) => {
    settings.lua = e.target.checked;
    save();
    send({ type: "lua", on: settings.lua });
  });
  pane.addEventListener("keydown", (e) => {
    if (e.key === "PageDown") { gotoPage(page + 1); e.preventDefault(); }
    if (e.key === "PageUp") { gotoPage(page - 1); e.preventDefault(); }
  });
  pane.tabIndex = 0;

  function gotoPage(n) {
    if (n < 0 || (done && n >= pageCount)) return;
    page = n;
    showPageNumber();
    send({ type: "page", page });
  }

  function sendWidth() {
    clearTimeout(widthTimer);
    widthTimer = setTimeout(() => {
      const w = Math.round((scroller.clientWidth || 800) * (window.devicePixelRatio || 1));
      send({ type: "width", width: w });
    }, 150);
  }
  new ResizeObserver(sendWidth).observe(ui);

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
    send({ type: "page", page });
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
        if (msg.page !== page) break;
        img.src = "data:image/png;base64," + msg.png;
        pageCount = Math.max(msg.count, page + 1);
        done = msg.done;
        showPageNumber();
        if (!$(".olive-status").classList.contains("olive-busy")) setStatus("live", false);
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
    if (on) { connect(); sendWidth(); }
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
