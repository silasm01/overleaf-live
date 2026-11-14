// texlive.js -- TeX Live for the browser engine (worker.js).
//
// The extension uses one pinned TeX Live repository (a "tlnet" folder, as
// tlmgr does). It downloads tlpkg/texlive.tlpdb.xz (the package index) one
// time, and archive/<package>.tar.xz only when a document needs one of its
// files. Everything is kept in the extension's Origin Private File System,
// for all projects.
//
// TeXpresso finds TeX Live files in ls-R files (common/texlive_provider.c).
// This file makes them from the index, so every TeX Live file is "known";
// host_tl_ensure (wasm/js/lib-tl.js) then calls ensure() when a file is
// opened, and ensure() gets the file's package if it is not there yet.
//
// Files that TeX Live's tools usually make:
//  - ls-R: from the index (all run files of all packages).
//  - language.dat (hyphenation, read when the format is made): language.us
//    + the AddHyphen entries of the index, as tlmgr makes it.
//  - pdftex.map (updmap): not made. When a font is not in the map, the
//    driver asks fontMaps() for the map files of the font's packages.
'use strict';

const TL_ROOT = '/texlive';
const TL_DIST = TL_ROOT + '/texmf-dist';
const TL_VAR = TL_ROOT + '/texmf-var';
const LANGUAGE_DAT = TL_VAR + '/tex/generic/config/language.dat';
const TL_FIXED_TIME = 1700000000000;   // all TeX Live files: one fixed mtime

class TexLive {
  // repos: tlnet URLs (the first that answers is used); version: a name for
  // the store (change it with the repository)
  constructor({ repos, version, log = () => {}, progress = () => {} }) {
    this.repos = repos;
    this.version = version;
    this.log = log;
    this.progress = progress;
    this.pkgs = new Map();       // name -> {name, files: [rel], maps: [], hyph: [{...}]}
    this.owner = new Map();      // rel path in texmf-dist -> package name
    this.byBase = new Map();     // file name -> [rel paths]
    this.files = new Map();      // absolute path -> bytes (packages in memory)
    this.loaded = new Set();     // packages in this.files
    this.cached = new Map();     // package -> File (in OPFS)
    this.written = new WeakMap();// module FS -> Set of paths written
    this.stats = { downloads: 0, downloadBytes: 0, fromCache: 0, ms: 0 };
  }

  async init(createXz) {
    const t0 = performance.now();
    this.xz = await createXz();
    const root = await navigator.storage.getDirectory();
    this.dir = await root.getDirectoryHandle('texlive-' + this.version, { create: true });
    this.pkgDir = await this.dir.getDirectoryHandle('packages', { create: true });
    let index = await readOpfs(this.dir, 'texlive.tlpdb.xz');
    if (!index) {
      this.progress('downloading the TeX Live package index');
      index = await this.fetchRepo('tlpkg/texlive.tlpdb.xz');
      await writeOpfs(this.dir, 'texlive.tlpdb.xz', index);
    }
    const text = new TextDecoder().decode(this.unxz(index));
    this.parse(text);
    this.stamp = (hashString(this.version) ^ text.length) & 0x3fffffff;
    for await (const [name, handle] of this.pkgDir.entries())
      if (name.endsWith('.tar')) this.cached.set(name.slice(0, -4), await handle.getFile());
    this.lsR = new TextEncoder().encode(this.makeLsR());
    this.lsRVar = new TextEncoder().encode('% ls-R -- made by Overleaf Live\n./tex/generic/config:\nlanguage.dat\n');
    this.log(`TeX Live ${this.version}: ${this.pkgs.size} packages, ${this.owner.size} files, ` +
      `${this.cached.size} packages kept, ${Math.round(performance.now() - t0)} ms`);
  }

  // ---- the package index (texlive.tlpdb) --------------------------------
  parse(text) {
    let cur = null, inRun = false;
    for (const line of text.split('\n')) {
      if (line === '') { cur = null; inRun = false; continue; }
      if (line.startsWith('name ')) {
        cur = { name: line.slice(5).trim(), files: [], maps: [], hyph: [] };
        this.pkgs.set(cur.name, cur);
        inRun = false;
        continue;
      }
      if (!cur) continue;
      if (line[0] === ' ') {
        if (!inRun) continue;
        let p = line.slice(1);
        const sp = p.indexOf(' ');
        if (sp >= 0) p = p.slice(0, sp);
        if (p.startsWith('RELOC/')) p = 'texmf-dist/' + p.slice(6);
        if (!p.startsWith('texmf-dist/')) continue;
        const rel = p.slice(11);
        cur.files.push(rel);
        this.owner.set(rel, cur.name);
        const base = rel.slice(rel.lastIndexOf('/') + 1);
        const list = this.byBase.get(base);
        if (list) list.push(rel); else this.byBase.set(base, [rel]);
        continue;
      }
      inRun = line.startsWith('runfiles');
      let m;
      if (line.startsWith('revision ')) { cur.rev = line.slice(9).trim(); continue; }
      if ((m = line.match(/^execute (?:addMap|addMixedMap|addKanjiMap) (\S+)/))) cur.maps.push(m[1]);
      else if ((m = line.match(/^execute AddHyphen (.*)$/))) {
        const h = {};
        for (const kv of m[1].trim().split(/\s+/)) {
          const i = kv.indexOf('=');
          if (i > 0) h[kv.slice(0, i)] = kv.slice(i + 1);
        }
        if (h.name) cur.hyph.push(h);
      }
    }
  }

  makeLsR() {
    const dirs = new Map();
    for (const rel of this.owner.keys()) {
      const i = rel.lastIndexOf('/');
      const d = i < 0 ? '' : rel.slice(0, i);
      const list = dirs.get(d);
      if (list) list.push(rel.slice(i + 1)); else dirs.set(d, [rel.slice(i + 1)]);
    }
    const out = ['% ls-R -- made by Overleaf Live from texlive.tlpdb'];
    for (const [d, names] of dirs) out.push('', d ? `./${d}:` : '.:', ...names);
    return out.join('\n') + '\n';
  }

  // The hyphenation patterns that the format loads (all, as TeX Live).
  hyphenationPackages() {
    return [...this.pkgs.values()].filter(p => p.hyph.length).map(p => p.name);
  }

  languageDat() {
    const us = this.read(TL_DIST + '/tex/generic/config/language.us');
    if (!us) return null;
    let text = new TextDecoder().decode(us);
    const have = new Set([...text.matchAll(/^(\S+)\s/gm)].map(m => m[1]));
    const names = [...this.pkgs.keys()].sort();
    for (const name of names) {
      const entries = this.pkgs.get(name).hyph.filter(h =>
        !have.has(h.name) && (!h.databases || h.databases.split(',').includes('dat')));
      if (!entries.length) continue;
      text += `% from ${name}:\n`;
      for (const h of entries) {
        text += `${h.name} ${h.file}\n`;
        for (const syn of (h.synonyms || '').split(',').filter(Boolean)) text += `=${syn}\n`;
      }
    }
    return new TextEncoder().encode(text);
  }

  // ---- files --------------------------------------------------------------
  // Puts the TeX Live tree's ls-R files in a module's file system; returns
  // the text for TEXPRESSO_LSR.
  setup(FS) {
    const set = this.writtenSet(FS);
    for (const [path, data] of [[TL_DIST + '/ls-R', this.lsR], [TL_VAR + '/ls-R', this.lsRVar]]) {
      putFile(FS, path, data);
      set.add(path);
    }
    return `${TL_VAR}/ls-R\n${TL_DIST}/ls-R\n`;
  }

  writtenSet(FS) {
    let set = this.written.get(FS);
    if (!set) { set = new Set(); this.written.set(FS, set); }
    return set;
  }

  // host_tl_ensure: the file at path in FS (false: it does not exist)
  ensure(path, FS) {
    const set = this.writtenSet(FS);
    if (set.has(path)) return true;
    const data = this.read(path);
    if (!data) return false;
    putFile(FS, path, data);
    set.add(path);
    return true;
  }

  // A TeX Live file by its name (for BibTeX's .bst and .bib files): its data,
  // or null. The package is downloaded if needed.
  findByName(name) {
    const base = name.slice(name.lastIndexOf('/') + 1);
    const rels = this.byBase.get(base);
    if (!rels) return null;
    const rel = rels.find(r => r.startsWith('bibtex/')) || rels[0];
    return this.read(`${TL_DIST}/${rel}`);
  }

  // host_tl_stat: what the format records for its TeX Live dependencies
  stat(path) {
    if (!path || !path.startsWith(TL_ROOT + '/')) return null;
    return { size: 1, mtime: this.stamp };
  }

  read(path) {
    const have = this.files.get(path);
    if (have) return have;
    if (path === LANGUAGE_DAT) {
      const data = this.languageDat();
      if (data) this.files.set(path, data);
      return data;
    }
    if (!path.startsWith(TL_DIST + '/')) return null;
    const pkg = this.owner.get(path.slice(TL_DIST.length + 1));
    if (!pkg) return null;
    this.loadSync(pkg);
    return this.files.get(path) || null;
  }

  // the map files for a font that is not in the map (see dvi_resmanager.c)
  fontMaps(font) {
    // no memory of earlier questions here: each new driver (a new start of
    // the engine) starts with no maps and must get them again
    const pkgs = new Set();
    for (const ext of ['.tfm', '.pfb', '.otf', '.ttf', '.vf'])
      for (const rel of this.byBase.get(font + ext) || []) pkgs.add(this.owner.get(rel));
    const maps = new Set();
    for (const p of pkgs) for (const m of (this.pkgs.get(p) || { maps: [] }).maps) maps.add(m);
    return [...maps].join('\n');
  }

  // ---- packages -------------------------------------------------------------
  loadSync(pkg) {
    if (this.loaded.has(pkg)) return;
    this.loaded.add(pkg);
    const t0 = performance.now();
    let tar = null;
    const file = this.cached.get(pkg);
    if (file) {
      tar = new Uint8Array(new FileReaderSync().readAsArrayBuffer(file));
      this.stats.fromCache++;
    } else {
      this.progress(`downloading TeX Live package ${pkg}`);
      const xz = this.fetchRepoSync(`archive/${pkg}.tar.xz`) || this.fetchRepoSync(this.versioned(pkg));
      if (!xz) { this.log(`package ${pkg}: download failed`); return; }
      tar = this.unxz(xz);
      this.stats.downloads++;
      this.stats.downloadBytes += xz.length;
      this.saveTar(pkg, tar);
    }
    this.addTar(tar);
    this.stats.ms += performance.now() - t0;
  }

  // Downloads packages in parallel (before the engine needs them).
  async prefetch(names, onCount = () => {}) {
    const todo = [...new Set(names)].filter(n => this.pkgs.has(n) && !this.loaded.has(n) && !this.cached.has(n));
    let done = 0;
    const one = async (pkg) => {
      try {
        const xz = await this.fetchRepo(`archive/${pkg}.tar.xz`).catch(e => {
          const v = this.versioned(pkg); if (!v) throw e; return this.fetchRepo(v); });
        if (!this.loaded.has(pkg)) {
          const tar = this.unxz(xz);
          this.loaded.add(pkg);
          this.stats.downloads++;
          this.stats.downloadBytes += xz.length;
          this.addTar(tar);
          await this.saveTar(pkg, tar);
        }
      } catch (e) { this.log(`package ${pkg}: ${e.message || e}`); }
      onCount(++done, todo.length);
    };
    const queue = todo.slice();
    const runners = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) await one(queue.shift());
    });
    await Promise.all(runners);
    return todo.length;
  }

  addTar(tar) {
    let p = 0, longName = null;
    const dec = new TextDecoder();
    const str = (a, b) => { let e = a; while (e < b && tar[e]) e++; return dec.decode(tar.subarray(a, e)); };
    while (p + 512 <= tar.length) {
      if (tar[p] === 0) break;
      const size = parseInt(str(p + 124, p + 136).trim() || '0', 8);
      const type = String.fromCharCode(tar[p + 156] || 48);
      let name = str(p, p + 100);
      const prefix = str(p + 345, p + 500);
      if (prefix && tar[p + 257] === 0x75) name = prefix + '/' + name;   // "ustar"
      const start = p + 512;
      const data = tar.subarray(start, start + size);
      p = start + Math.ceil(size / 512) * 512;
      if (type === 'L') { longName = str(start, start + size); continue; }
      if (type === 'x') {
        const m = dec.decode(data).match(/\d+ path=([^\n]*)\n/);
        if (m) longName = m[1];
        continue;
      }
      if (longName) { name = longName; longName = null; }
      if (type !== '0' && type !== '\0' && type !== '7') continue;
      name = name.replace(/^\.\//, '');
      if (name.startsWith('tlpkg/')) continue;
      const rel = name.startsWith('texmf-dist/') ? name.slice(11) : name;
      this.files.set(`${TL_DIST}/${rel}`, data);
    }
  }

  async saveTar(pkg, tar) {
    try {
      await writeOpfs(this.pkgDir, pkg + '.tar', tar);
    } catch (e) { this.log(`package ${pkg} not kept: ${e.message || e}`); }
  }

  unxz(bytes) {
    const m = this.xz;
    const p = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, p);
    const out = m._xz_decompress(p, bytes.length);
    m._free(p);
    if (!out) throw new Error('xz: the data is damaged');
    const data = m.HEAPU8.slice(out, out + m._xz_out_len());
    m._free(out);
    return data;
  }

  async fetchRepo(rel) {
    let last;
    for (const repo of this.orderedRepos()) {
      try {
        const r = await fetch(`${repo}/${rel}`);
        if (r.ok) { this.goodRepo = repo; return new Uint8Array(await r.arrayBuffer()); }
        last = new Error(`HTTP ${r.status} from ${repo}`);
      } catch (e) { last = e; }
    }
    throw last || new Error('no repository');
  }

  fetchRepoSync(rel) {
    if (!rel) return null;
    for (const repo of this.orderedRepos()) {
      try {
        const x = new XMLHttpRequest();
        x.open('GET', `${repo}/${rel}`, false);
        x.responseType = 'arraybuffer';
        x.send();
        if (x.status === 200) { this.goodRepo = repo; return new Uint8Array(x.response); }
      } catch (e) { /* the next one */ }
    }
    return null;
  }

  // Some mirrors of the historic archive keep only <package>.r<revision>.tar.xz.
  versioned(pkg) {
    const p = this.pkgs.get(pkg);
    return p && p.rev ? `archive/${pkg}.r${p.rev}.tar.xz` : null;
  }

  orderedRepos() {
    return this.goodRepo ? [this.goodRepo, ...this.repos.filter(r => r !== this.goodRepo)] : this.repos;
  }
}

// The TeX Live packages that a project's files name (\usepackage, ...).
function projectPackages(tl, files) {
  const want = new Set();
  const dec = new TextDecoder();
  const add = (file) => { const rels = tl.byBase.get(file); if (rels) want.add(tl.owner.get(rels[0])); };
  for (const [rel, data] of files) {
    if (!/\.(tex|sty|cls|ltx)$/i.test(rel) || data.length > 2e6) continue;
    const text = dec.decode(data).replace(/(^|[^\\])%.*$/gm, '$1');
    for (const m of text.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g))
      for (const n of m[1].split(',')) add(n.trim() + '.sty');
    for (const m of text.matchAll(/\\(?:documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g))
      add(m[1].trim() + '.cls');
    for (const m of text.matchAll(/\\usetikzlibrary\s*\{([^}]*)\}/g))
      for (const n of m[1].split(',')) { add(`tikzlibrary${n.trim()}.code.tex`); add(`pgflibrary${n.trim()}.code.tex`); }
    for (const m of text.matchAll(/\\usepgfplotslibrary\s*\{([^}]*)\}/g))
      for (const n of m[1].split(',')) add(`pgfplotslibrary${n.trim()}.code.tex`);
  }
  want.delete(undefined);
  return [...want];
}

// What the XeLaTeX format needs, besides the hyphenation packages.
const FORMAT_PACKAGES = ['hyphen-base', 'hyph-utf8', 'latex', 'l3kernel', 'l3backend', 'latexconfig',
  'tex-ini-files', 'babel', 'unicode-data', 'lm', 'etex', 'knuth-lib', 'plain', 'cm', 'amsfonts',
  'latex-fonts', 'firstaid', 'graphics-def', 'latex-lab', 'xetexconfig', 'xetex', 'tipa'];

function putFile(FS, path, data) {
  FS.mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
  FS.writeFile(path, data);
  FS.utime(path, TL_FIXED_TIME, TL_FIXED_TIME);
}

async function readOpfs(dir, name) {
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch { return null; }
}

async function writeOpfs(dir, name, data) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
