// offscreen.js -- the offscreen document of Overleaf Live: keeps the engine
// worker (worker.js) and connects it to background.js. An offscreen document
// with the reason WORKERS has no time limit; the service worker has one.
const worker = new Worker('worker.js');
let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'olive-engine' });
  port.onMessage.addListener((m) => worker.postMessage(m));
  port.onDisconnect.addListener(() => {
    // the service worker stopped: its tab ports are gone too
    port = null;
    worker.postMessage({ reset: true });
    setTimeout(connect, 500);
  });
}

worker.onmessage = (e) => { if (port) port.postMessage(e.data); };
worker.onerror = (e) => console.error('[olive-engine] worker error', e.message);
// messages keep the service worker running while the engine is in use
setInterval(() => { if (port) port.postMessage({ keepalive: true }); }, 20000);
connect();
