// background.js -- connects each Overleaf tab to the engine.
//  - "browser" (default): TeXpresso in WebAssembly, in a Web Worker of the
//    offscreen document (engine/offscreen.html, engine/worker.js).
//  - "wsl": the local helper in WSL, over a WebSocket.
// The setting is chrome.storage.local "engine"; the Live menu changes it.
const HELPER_URL = "ws://127.0.0.1:47823";

function engineMode() {
  return new Promise((resolve) =>
    chrome.storage.local.get("engine", (r) => resolve(r.engine === "wsl" ? "wsl" : "browser")));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "olive-engine") return engineConnected(port);
  if (port.name !== "overleaf-live") return;
  engineMode().then((mode) => (mode === "wsl" ? wslClient(port) : browserClient(port)));
});

// --- browser engine ------------------------------------------------------
let enginePort = null;            // the offscreen document's port
let engineWaiters = [];
const clients = new Map();        // client id -> tab port
let nextClient = 1;
let creating = null;

function engineConnected(port) {
  enginePort = port;
  port.onMessage.addListener((m) => {
    if (m.keepalive) return;
    const msg = m.msg;
    if (!msg) return;
    if (m.to != null) {
      const tab = clients.get(m.to);
      if (tab) try { tab.postMessage(msg); } catch (e) { /* tab is gone */ }
    } else {
      for (const tab of clients.values()) try { tab.postMessage(msg); } catch (e) { /* tab is gone */ }
    }
  });
  port.onDisconnect.addListener(() => {
    enginePort = null;
    for (const tab of clients.values()) try { tab.postMessage({ type: "disconnected" }); } catch (e) {}
  });
  const waiters = engineWaiters;
  engineWaiters = [];
  waiters.forEach((w) => w());
}

async function ensureEngine() {
  if (enginePort) return;
  const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!have.length) {
    if (!creating) {
      creating = chrome.offscreen.createDocument({
        url: "engine/offscreen.html",
        reasons: ["WORKERS"],
        justification: "Runs TeXpresso (WebAssembly) in a worker for the live preview.",
      }).finally(() => { creating = null; });
    }
    await creating;
  }
  if (!enginePort) await new Promise((resolve) => engineWaiters.push(resolve));
}

function browserClient(port) {
  const id = nextClient++;
  clients.set(id, port);
  let open = true;
  port.onMessage.addListener((msg) => {
    if (enginePort) enginePort.postMessage({ client: id, msg });
  });
  port.onDisconnect.addListener(() => {
    open = false;
    clients.delete(id);
    if (enginePort) enginePort.postMessage({ client: id, closed: true });
  });
  ensureEngine().then(() => {
    if (open) try { port.postMessage({ type: "connected", engine: "browser" }); } catch (e) {}
  }).catch((e) => {
    try { port.postMessage({ type: "status", text: "the browser engine could not start: " + e.message, busy: false }); } catch (x) {}
  });
}

// --- WSL helper --------------------------------------------------------------
// Each Overleaf tab gets its own WebSocket.
function wslClient(port) {
  let ws = null;
  let closed = false;
  let retry = null;
  let ping = null;

  const toTab = (msg) => {
    try { port.postMessage(msg); } catch (e) { /* tab is gone */ }
  };

  function connect() {
    if (closed) return;
    ws = new WebSocket(HELPER_URL);
    ws.onopen = () => {
      toTab({ type: "connected", engine: "wsl" });   // the tab then starts its session
      // activity keeps this service worker running
      ping = setInterval(() => ws && ws.readyState === 1 && ws.send('{"type":"ping"}'), 20000);
    };
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (msg.type === "versions") return checkVersion(msg.extension);
      toTab(msg);
    };
    ws.onclose = () => {
      clearInterval(ping);
      ws = null;
      if (closed) return;
      toTab({ type: "disconnected" });
      retry = setTimeout(connect, 3000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  port.onMessage.addListener((msg) => {
    // not connected: dropped; the tab sends everything again on "connected"
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  });

  port.onDisconnect.addListener(() => {
    closed = true;
    clearTimeout(retry);
    clearInterval(ping);
    if (ws) ws.close();
  });

  connect();
}

// update.sh copies a new version of the extension to its folder; Chrome
// only loads it on a reload. Reload once for each new version (not again
// if the folder Chrome uses is another one and the version stays old).
function checkVersion(installed) {
  const mine = chrome.runtime.getManifest().version;
  if (!installed || installed === mine) return;
  chrome.storage.local.get("reloadedFor", (r) => {
    if (r.reloadedFor === installed) return;
    chrome.storage.local.set({ reloadedFor: installed }, () => chrome.runtime.reload());
  });
}
