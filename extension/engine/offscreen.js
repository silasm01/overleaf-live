// offscreen.js -- the offscreen document of Overleaf Live: keeps the engine
// workers (worker.js) and connects them to background.js. An offscreen
// document with the reason WORKERS has no time limit; the service worker has
// one.
//
// One worker for each Overleaf project: a worker has one project (its
// TeXpresso run, files and pages), so two projects open in two tabs each
// get their own. The worker's messages "to: null" (all tabs of the project)
// go to the tabs of its project only.
//
// The TeX Live store and the format must stay (one download only): ask Chrome
// not to delete them when the disk is full (unlimitedStorage gives the quota).
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const MAX_PROJECTS = 3;           // workers at a time (each has its own engine memory)
const IDLE_MS = 5 * 60 * 1000;    // a worker without tabs stops after this
const workers = new Map();        // project id -> {worker, clients: Set, idle: timer, used}
const clientProject = new Map();  // client id -> project id
let config = null;                // {config: ...}: given to each new worker
let port = null;

function workerFor(project) {
  let w = workers.get(project);
  if (w) return w;
  // too many: the one used least recently that has no tab goes, else the
  // least recently used one
  if (workers.size >= MAX_PROJECTS) {
    const all = [...workers.entries()].sort((a, b) =>
      (a[1].clients.size > 0) - (b[1].clients.size > 0) || a[1].used - b[1].used);
    endWorker(all[0][0], "another project needed the engine; reload this tab to go on");
  }
  const worker = new Worker('worker.js');
  w = { worker, clients: new Set(), idle: null, used: Date.now() };
  worker.onmessage = (e) => {
    const m = e.data;
    if (!port || !m) return;
    if (m.to != null) port.postMessage(m);
    else for (const c of w.clients) port.postMessage({ to: c, msg: m.msg });
  };
  worker.onerror = (e) => console.error('[olive-engine]', project, 'worker error', e.message);
  if (config) worker.postMessage(config);
  workers.set(project, w);
  return w;
}

function endWorker(project, why) {
  const w = workers.get(project);
  if (!w) return;
  clearTimeout(w.idle);
  for (const c of w.clients) {
    clientProject.delete(c);
    if (port && why) port.postMessage({ to: c, msg: { type: 'status', text: why, busy: false } });
  }
  w.worker.terminate();
  workers.delete(project);
}

function fromTab(m) {
  if (m.config) {
    config = m;
    for (const w of workers.values()) w.worker.postMessage(m);
    return;
  }
  if (m.reset) {
    // the service worker stopped: its tab ports are gone; the tabs say hello again
    for (const [project, w] of workers) {
      w.worker.postMessage(m);
      w.clients.clear();
      armIdle(project, w);
    }
    clientProject.clear();
    return;
  }
  const client = m.client;
  if (m.closed) {
    const project = clientProject.get(client);
    clientProject.delete(client);
    const w = project && workers.get(project);
    if (w) {
      w.clients.delete(client);
      w.worker.postMessage(m);
      armIdle(project, w);
    }
    return;
  }
  const msg = m.msg;
  if (!msg) return;
  if (msg.type === 'hello') {
    const project = String(msg.project || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!project) return;
    // a tab that had another project before (it changed project)
    const was = clientProject.get(client);
    if (was && was !== project && workers.has(was)) {
      const old = workers.get(was);
      old.clients.delete(client);
      old.worker.postMessage({ client, closed: true });
      armIdle(was, old);
    }
    const w = workerFor(project);
    clearTimeout(w.idle);
    w.idle = null;
    w.clients.add(client);
    w.used = Date.now();
    clientProject.set(client, project);
    w.worker.postMessage(m);
    return;
  }
  const project = clientProject.get(client);
  const w = project && workers.get(project);
  if (!w) return;          // no hello yet (or its worker was ended): dropped
  w.used = Date.now();
  w.worker.postMessage(m);
}

function armIdle(project, w) {
  if (w.clients.size || w.idle) return;
  w.idle = setTimeout(() => { if (!w.clients.size) endWorker(project, null); }, IDLE_MS);
}

function connect() {
  port = chrome.runtime.connect({ name: 'olive-engine' });
  port.onMessage.addListener(fromTab);
  port.onDisconnect.addListener(() => {
    port = null;
    fromTab({ reset: true });
    setTimeout(connect, 500);
  });
}

// messages keep the service worker running while the engine is in use
setInterval(() => { if (port) port.postMessage({ keepalive: true }); }, 20000);
connect();
