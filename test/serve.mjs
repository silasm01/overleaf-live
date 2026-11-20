// serve.mjs -- a small static server for the tests (no packages needed):
//   /            test/site
//   /engine/     extension/engine (the browser engine)
//   /tlnet/      the test TeX Live repository (make-fake-tlnet.py)
//   /project/<id>             a fake Overleaf page (site/overleaf.html)
//   /Project/<id>/download/zip  its project zip (server.state.zip)
import http from 'http';
import fs from 'fs';
import path from 'path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.xz': 'application/x-xz' };

export function serve({ root, tlnet, port = 0 }) {
  const mounts = [['/engine/', path.join(root, 'extension/engine')], ['/tlnet/', tlnet], ['/', path.join(root, 'test/site')]];
  const state = { zip: null };     // the project zip of the fake Overleaf page (viewer tests)
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    res.setHeader('Access-Control-Allow-Origin', '*');
    // the fake Overleaf: /project/<id> (and /detached), and its zip download
    if (/^\/project\/[0-9a-f]{24}(\/detached)?$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      fs.createReadStream(path.join(root, 'test/site/overleaf.html')).pipe(res);
      return;
    }
    if (/^\/Project\/[0-9a-f]{24}\/download\/zip$/.test(url)) {
      if (!state.zip) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': state.zip.length });
      res.end(state.zip);
      return;
    }
    for (const [prefix, dir] of mounts) {
      if (!url.startsWith(prefix)) continue;
      const file = path.resolve(dir, '.' + url.slice(prefix.length - 1));
      if (!file.startsWith(path.resolve(dir))) break;
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
          'Content-Length': st.size, 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  server.state = state;
  return new Promise(resolve => server.listen(port || 8797, '127.0.0.1', () => resolve(server)));
}
