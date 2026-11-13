// background.js -- keeps the WebSocket to the local helper (in WSL).
// Each Overleaf tab gets its own port here and its own WebSocket.
const HELPER_URL = "ws://127.0.0.1:47823";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "overleaf-live") return;
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
      toTab({ type: "connected" });   // the tab then starts its session
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
});

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
