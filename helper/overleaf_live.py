#!/usr/bin/env python3
"""
overleaf_live.py -- the local half of Overleaf Live.

The Chrome extension sends the Overleaf project (a zip) and every edit
here, over a WebSocket on 127.0.0.1. This program keeps a copy of the
project on disk, runs TeXpresso on it, and sends each page back as a PNG
as soon as TeXpresso has typeset it.

Lua modules (calc, fsm) under XeLaTeX need shell escape. TeXpresso has
none, so with "Lua" turned on for a project, a normal compile
(latexmk -xelatex -shell-escape) runs in the background after a pause in
typing, and TeXpresso then reads its saved results. Shell escape can run
any command, so it is only done for projects where it is turned on in
the extension.

Several tabs can connect for the same project: with Overleaf's "PDF in
separate tab", the editor tab sends the edits and the PDF tab shows the
pages. Everything TeXpresso reports goes to all tabs of the project.

Messages (JSON, one per WebSocket message)
  extension -> helper
    {"type": "hello", "project": id, "main": "main.tex", "lua": bool}
    {"type": "project", "zip": base64}       the whole project
    {"type": "edit", "path": "main.tex", "text": "..."}
    {"type": "view", "first": n, "last": n}  the visible pages (from 0)
    {"type": "width", "width": px}           picture width in pixels
    {"type": "lua", "on": bool}
    {"type": "cursor", "path": p, "line": n, "column": n}   editor cursor
                                             (line from 1, column from 0)
    {"type": "scan", "page": n, "x": pt, "y": pt}   double-click on a page
    {"type": "caretDebug", "on": bool}       debug panel: the caret map
    {"type": "caretMap", "page": n}          debug panel: the caret map of a page
    {"type": "caretElements", "page": n}     debug panel: the TikZ elements of a page
  helper -> extension
    {"type": "versions", "extension": "0.1.1"}   the version install.sh put
                                             in the Windows folder
    {"type": "status", "text": "...", "busy": bool}
    {"type": "page", "page": n, "count": n, "done": bool, "png": base64,
     "w": points, "h": points}                page size
    {"type": "count", "count": n, "done": bool}   pages so far; done: all
    {"type": "errors", "lines": ["...", ...]}
    {"type": "caret", "page": n, "x": pt, "y": pt, "h": pt, "d": pt,
     "box": [x0, y0, x1, y1], "element": true}   the cursor in the PDF (y is the
                                             baseline; h, d: line height; box:
                                             only for a part that does not map
                                             1:1 to its glyphs, e.g. a math symbol;
                                             element: a picture or a TikZ element,
                                             shown as the box only)
    {"type": "caretElements", "page": n, "elements": [{"kind", "line", "end", "index",
     "depth", "box", "file", "src": [l0, c0, l1, c1]}, ...]}   debug panel
    {"type": "caretDebug", "page": n, "points": [[line, col, x, y, h, d, box], ...],
     "boxes": [[x0, y0, x1, y1], ...]}       debug panel: every character near
                                             the cursor
    {"type": "goto", "path": p, "line": n, "column": n}   reverse search
    {"type": "field", "path": p, "from": [line, col], "to": [line, col],
     "box": [x0, y0, x1, y1], "text": s}     quick edit: the double-clicked
                                             field (before its goto)

SyncTeX: TeXpresso's engine (patched) writes the column next to the line
in each SyncTeX record, so both directions work to about one character in
normal text; inside a macro argument, to the argument.
"""
import asyncio
import base64
import io
import json
import os
import re
import shlex
import shutil
import signal
import sys
import time
import zipfile
from pathlib import Path

import websockets

PORT = int(os.environ.get("OVERLEAF_LIVE_PORT", "47823"))
# Only the extension may connect: a web page can't fake its Origin
EXTENSION_ID = os.environ.get("OVERLEAF_LIVE_EXTENSION", "ocdaihokchcbanejcpclejmpaobbafcj")
TEXPRESSO = os.environ.get("TEXPRESSO", str(Path.home() / "texpresso/build/texpresso"))
ROOT = Path(os.environ.get("OVERLEAF_LIVE_DIR", str(Path.home() / ".overleaf-live")))
LUA_IDLE = 2.0          # seconds without edits before the background compile
LUA_TIMEOUT = 120       # seconds a background compile may take


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def sexp_string(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def safe_path(root, rel):
    """rel inside root, or None (no ../ out of the project)"""
    p = (root / rel).resolve()
    return p if p == root.resolve() or root.resolve() in p.parents else None


class Project:
    """One Overleaf project: its folder, TeXpresso, the background compile
    and the tabs connected to it."""

    def __init__(self, project):
        self.project = project
        self.dir = ROOT / project
        self.dir.mkdir(parents=True, exist_ok=True)
        self.clients = set()
        self.main = ""
        self.lua = False
        self.caret_debug = False
        self.pages = {}             # page -> last "page" message (for new tabs)
        self.last_msg = {}          # "status", "errors", "count" -> last message
        self.width = 1000
        self.first = 0              # the visible pages
        self.last = 0
        self.proc = None
        self.reader = None
        self.out = ""               # TeXpresso's terminal output (for errors)
        self.sent_errors = None
        self.export_dir = None
        self.last_edit = 0.0
        self.lua_dirty = False
        self.lua_task = None
        self.lua_running = False

    async def send(self, msg, to=None):
        """to all tabs of the project (or only to one)"""
        if to is None:
            if msg["type"] in ("status", "errors", "count"):
                self.last_msg[msg["type"]] = msg
            if msg["type"] == "page":
                self.pages[msg["page"]] = msg
        data = json.dumps(msg)
        for ws in ([to] if to else list(self.clients)):
            try:
                await ws.send(data)
            except websockets.ConnectionClosed:
                pass

    async def status(self, text, busy=False):
        log("status:", text)
        await self.send({"type": "status", "text": text, "busy": busy})

    # --- TeXpresso -----------------------------------------------------
    def find_main(self):
        """main.tex, else the first .tex at the top with \\documentclass"""
        if self.main and (self.dir / self.main).exists():
            return
        candidates = sorted(self.dir.glob("*.tex"), key=lambda p: (p.name != "main.tex", p.name))
        for p in candidates:
            try:
                if "\\documentclass" in p.read_text(encoding="utf-8", errors="replace"):
                    self.main = p.name
                    return
            except OSError:
                pass

    def include_dirs(self):
        """The folders that latexmkrc adds to TEXINPUTS (e.g. template//),
        as -I options: TeXpresso doesn't read TEXINPUTS for project files.
        A folder ending in // also gives its subfolders, as in TeX."""
        rc = self.dir / "latexmkrc"
        if not rc.exists():
            return []
        dirs = []
        for line in rc.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.split("#", 1)[0]
            if "TEXINPUTS" not in line:
                continue
            for quoted in re.findall(r"""['"]([^'"]*)['"]""", line):
                for entry in quoted.split(":"):
                    entry = re.sub(r"\$\{?repo\}?", ".", entry).strip()
                    if entry in ("", ".", "./", "TEXINPUTS"):
                        continue
                    recursive = entry.endswith("//")
                    d = safe_path(self.dir, entry.rstrip("/"))
                    if d is None or not d.is_dir() or d == self.dir.resolve():
                        continue
                    found = [d] + (sorted(x for x in d.rglob("*") if x.is_dir()) if recursive else [])
                    for x in found:
                        if x not in dirs:
                            dirs.append(x)
        args = []
        for d in dirs:
            args += ["-I", str(d)]
        return args

    async def start_texpresso(self):
        await self.stop_texpresso()
        self.find_main()
        if not (self.dir / self.main).exists():
            await self.status(f"{self.main} not found in the project", False)
            return
        self.export_dir = self.dir / ".overleaf-live-pages"
        shutil.rmtree(self.export_dir, ignore_errors=True)
        self.export_dir.mkdir()
        env = dict(os.environ, SDL_VIDEODRIVER="offscreen")
        self.proc = await asyncio.create_subprocess_exec(
            TEXPRESSO, "-texlive", *self.include_dirs(), self.main, cwd=self.dir, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=2**24,
            start_new_session=True)     # its own group: see kill_group
        self.out = ""
        self.sent_errors = None
        self.pages.clear()
        self.reader = asyncio.create_task(self.read_texpresso(self.proc))
        await self.command(f"(export-png {sexp_string(str(self.export_dir))} {int(self.width)})")
        await self.command(f"(export-range {self.first} {self.last})")
        if self.caret_debug:
            await self.command("(caret-debug t)")
        await self.command("(rescan)")
        await self.status("typesetting", True)

    def kill_group(self):
        """TeXpresso forks engine processes (its snapshots); killing only
        TeXpresso leaves them running. Kill its whole process group."""
        if self.proc:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    async def stop_texpresso(self):
        if self.proc:
            self.kill_group()
            await self.proc.wait()
        if self.reader:
            self.reader.cancel()
        self.proc = self.reader = None

    async def command(self, line):
        if self.proc and self.proc.returncode is None:
            self.proc.stdin.write(line.encode() + b"\n")
            await self.proc.stdin.drain()

    async def read_texpresso(self, proc):
        page_re = re.compile(r'^\(page-image (\d+) (\d+) (\d) "(.*)"(?: ([\d.]+) ([\d.]+))?\)$')
        count_re = re.compile(r'^\(page-count (\d+) (\d)\)$')
        append_re = re.compile(r'^\(append out (\d+) "(.*)"\)$')
        caret_re = re.compile(r'^\(synctex-target (\d+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)((?: [-\d.]+){4})?( element)?\)$')
        back_re = re.compile(r'^\(synctex "(.*)" (-?\d+) (-?\d+)\)$')
        field_re = re.compile(r'^\(synctex-field "((?:[^"\\]|\\.)*)" (\d+) (\d+) (\d+) (\d+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) "((?:[^"\\]|\\.)*)"\)$')
        trunc_re = re.compile(r'^\(truncate out (\d+)\)$')
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace").rstrip("\n")
            m = page_re.match(line)
            if m:
                page, count, done, path = int(m[1]), int(m[2]), m[3] == "1", m[4]
                try:
                    data = Path(path).read_bytes()
                    os.unlink(path)
                except OSError:
                    continue
                await self.send({"type": "page", "page": page, "count": count,
                                 "done": done, "png": base64.b64encode(data).decode(),
                                 "w": float(m[5] or 595.28), "h": float(m[6] or 841.89)})
                continue
            m = caret_re.match(line)
            if m:
                caret = {"type": "caret", "page": int(m[1]), "x": float(m[2]),
                         "y": float(m[3]), "h": float(m[4]), "d": float(m[5])}
                if m[6]:
                    caret["box"] = [float(v) for v in m[6].split()]
                if m[7]:
                    caret["element"] = True
                await self.send(caret)
                continue
            if line.startswith("(synctex-debug "):
                await self.send(parse_caret_debug(line))
                continue
            if line.startswith("(synctex-elements "):
                await self.send(parse_elements(line))
                continue
            m = field_re.match(line)
            if m:
                rel = self.project_path(re.sub(r'\\(.)', r'\1', m[1]))
                if rel:
                    text = re.sub(r'\\(.)', lambda k: "\n" if k[1] == "n" else k[1], m[10])
                    await self.send({"type": "field", "path": rel,
                                     "from": [int(m[2]), int(m[3])], "to": [int(m[4]), int(m[5])],
                                     "box": [float(m[i]) for i in range(6, 10)], "text": text})
                continue
            m = back_re.match(line)
            if m:
                rel = self.project_path(re.sub(r'\\(.)', r'\1', m[1]))
                if rel:
                    await self.send({"type": "goto", "path": rel, "line": int(m[2]),
                                     "column": max(0, int(m[3]))})
                continue
            m = count_re.match(line)
            if m:
                await self.send({"type": "count", "count": int(m[1]), "done": m[2] == "1"})
                continue
            m = append_re.match(line)
            if m:
                # byte offsets: keep it simple and treat the text as appended
                text = re.sub(r'\\(.)', lambda e: "\n" if e[1] == "n" else e[1], m[2])
                self.out = self.out[: int(m[1])] + text
                continue
            m = trunc_re.match(line)
            if m:
                self.out = self.out[: int(m[1])]
                continue
            if line == "(flush)":
                await self.report_errors()
        if self.proc is proc:
            await self.status("TeXpresso stopped (it restarts with the next edit)", False)
            self.proc = None

    def project_path(self, path):
        """a path from TeXpresso -> the path in the Overleaf project"""
        full = os.path.normpath(path if os.path.isabs(path) else os.path.join(self.dir, path))
        rel = os.path.relpath(full, os.path.realpath(self.dir))
        if rel.startswith(".."):
            rel = os.path.relpath(full, self.dir)
        return None if rel.startswith("..") else rel.replace(os.sep, "/")

    async def report_errors(self):
        lines = []
        for chunk in self.out.split("\n! ")[1:]:
            first = chunk.split("\n")[0].strip()
            loc = re.search(r"\nl\.(\d+)", chunk)
            lines.append(first + (f" (line {loc[1]})" if loc else ""))
        if lines != self.sent_errors:
            self.sent_errors = lines
            await self.send({"type": "errors", "lines": lines[:20]})

    # --- background compile for luabridge ----------------------------
    def schedule_lua(self):
        if not self.lua:
            return
        self.lua_dirty = True
        if not self.lua_task or self.lua_task.done():
            self.lua_task = asyncio.create_task(self.lua_loop())

    async def lua_loop(self):
        while self.lua_dirty and self.lua:
            wait = LUA_IDLE - (time.time() - self.last_edit)
            if wait > 0:
                await asyncio.sleep(wait)
                continue
            self.lua_dirty = False
            self.lua_running = True
            await self.status("updating Lua results", True)
            t0 = time.time()
            had_keys = bool(list(self.dir.glob("*.luakeys")))
            try:
                p = await asyncio.create_subprocess_exec(
                    "latexmk", "-xelatex", "-shell-escape", "-interaction=nonstopmode",
                    self.main, cwd=self.dir,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
                try:
                    out, _ = await asyncio.wait_for(p.communicate(), LUA_TIMEOUT)
                except asyncio.TimeoutError:
                    p.kill()
                    out = b"(stopped: took too long)"
                tail = out.decode("utf-8", "replace").strip().splitlines()[-6:]
                log(f"latexmk exit {p.returncode}:", *("\n    " + t for t in tail))
            except FileNotFoundError:
                await self.status("latexmk not found (is TeX Live on PATH?)", False)
                return
            finally:
                self.lua_running = False
            if had_keys:
                await self.command("(rescan)")
            else:
                # TeXpresso's rescan sees changed files, not new ones
                await self.start_texpresso()
            await self.status(f"Lua results updated ({time.time() - t0:.1f} s)", False)

    # --- messages from the extension ---------------------------------
    async def join(self, ws, msg):
        """a tab connected: give it what the other tabs already have"""
        self.clients.add(ws)
        if msg.get("main"):
            self.main = msg["main"]
        self.lua = bool(msg.get("lua"))
        for kind in ("status", "errors", "count"):
            if kind in self.last_msg:
                await self.send(self.last_msg[kind], to=ws)
        if not self.proc:
            await self.status("waiting for the project files", True)

    async def leave(self, ws):
        self.clients.discard(ws)
        if not self.clients:
            await self.stop_texpresso()
            if self.lua_task:
                self.lua_task.cancel()

    async def on_project(self, ws, msg):
        data = base64.b64decode(msg["zip"])
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                target = safe_path(self.dir, info.filename)
                if target is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(info))
        log(f"project {self.project}: {len(data) // 1024} KiB unpacked")
        if self.proc and self.proc.returncode is None:
            await self.command("(rescan)")
            await self.status("project files updated", False)
        else:
            await self.start_texpresso()
        if self.lua and not list(self.dir.glob("*.luakeys")):
            self.last_edit = 0
            self.schedule_lua()

    async def on_edit(self, ws, msg):
        target = safe_path(self.dir, msg.get("path", ""))
        if target is None:
            return
        text = msg.get("text", "")
        rel = str(target.relative_to(self.dir.resolve()))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")   # for the background compile
        self.last_edit = time.time()
        if not self.proc or self.proc.returncode is not None:
            await self.start_texpresso()
        await self.command(f"(open {sexp_string(rel)} {sexp_string(text)})")
        self.schedule_lua()

    async def on_view(self, ws, msg):
        self.first = max(0, int(msg.get("first", 0)))
        self.last = max(self.first, min(self.first + 20, int(msg.get("last", self.first))))
        # pages TeXpresso already sent (it sends a page again only when it
        # changes): a tab that just opened needs them now
        for page in range(self.first, self.last + 1):
            if page in self.pages:
                await self.send(self.pages[page], to=ws)
        await self.command(f"(export-range {self.first} {self.last})")

    async def on_width(self, ws, msg):
        width = max(200, min(4000, int(msg.get("width", 1000))))
        if width == self.width:
            return
        self.width = width
        self.pages.clear()          # TeXpresso sends all visible pages again
        if self.export_dir:
            await self.command(f"(export-png {sexp_string(str(self.export_dir))} {self.width})")

    async def on_cursor(self, ws, msg):
        """forward search: TeXpresso answers with (synctex-target ...)"""
        target = safe_path(self.dir, msg.get("path", ""))
        if target is None or not self.proc or self.proc.returncode is not None:
            return
        line = max(1, int(msg.get("line", 1)))
        column = max(0, int(msg.get("column", 0)))
        await self.command(f"(synctex-forward {sexp_string(str(target))} {line} {column})")

    async def on_scan(self, ws, msg):
        """reverse search: TeXpresso answers with (synctex "path" line column)"""
        if not self.proc or self.proc.returncode is not None:
            return
        page = max(0, int(msg.get("page", 0)))
        x, y = float(msg.get("x", 0)), float(msg.get("y", 0))
        await self.command(f"(synctex-scan {page} {x:.2f} {y:.2f})")

    async def on_caret_elements(self, ws, msg):
        await self.command(f"(caret-elements {max(0, int(msg.get('page', 0)))})")

    async def on_caret_map(self, ws, msg):
        await self.command(f"(caret-map {max(0, int(msg.get('page', 0)))})")

    async def on_caret_debug(self, ws, msg):
        self.caret_debug = bool(msg.get("on"))
        await self.command(f"(caret-debug {'t' if self.caret_debug else 'nil'})")

    async def on_lua(self, ws, msg):
        self.lua = bool(msg.get("on"))
        if self.lua:
            self.last_edit = 0
            self.schedule_lua()

def parse_caret_debug(line):
    """(synctex-debug page n line col x y h d box ... m x0 y0 x1 y1 ...)"""
    v = [float(x) for x in line[1:-1].split()[1:]]
    page, n = int(v[0]), int(v[1])
    i = 2
    points = []
    for _ in range(n):
        points.append(v[i:i + 7])
        i += 7
    m = int(v[i]) if i < len(v) else 0
    i += 1
    boxes = [v[i + 4 * k:i + 4 * k + 4] for k in range(m)]
    return {"type": "caretDebug", "page": page, "points": points, "boxes": boxes}


def parse_elements(line):
    """(synctex-elements page n kind line end index depth x0 y0 x1 y1 "file" l0 c0 l1 c1 ...)"""
    toks = shlex.split(line[1:-1])
    page, n = int(toks[1]), int(toks[2])
    elements = []
    for k in range(n):
        i = 3 + 14 * k
        elements.append({"kind": toks[i], "line": int(toks[i + 1]), "end": int(toks[i + 2]),
                         "index": int(toks[i + 3]), "depth": int(toks[i + 4]),
                         "box": [float(v) for v in toks[i + 5:i + 9]], "file": toks[i + 9],
                         "src": [int(v) for v in toks[i + 10:i + 14]]})
    return {"type": "caretElements", "page": page, "elements": elements}


PROJECTS = {}                   # project id -> Project


def installed_extension_version():
    """written by install.sh: the version in the Windows extension folder"""
    try:
        return (Path.home() / "overleaf-live/extension-version").read_text().strip()
    except OSError:
        return ""


async def handler(ws, path=None):
    log("extension connected")
    await ws.send(json.dumps({"type": "versions", "extension": installed_extension_version()}))
    project = None
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "hello":
                    pid = re.sub(r"[^A-Za-z0-9_-]", "", str(msg.get("project", "")))
                    if not pid:
                        continue
                    if project:
                        await project.leave(ws)
                    project = PROJECTS.get(pid) or PROJECTS.setdefault(pid, Project(pid))
                    await project.join(ws, msg)
                    continue
                handler_fn = project and {
                    "project": project.on_project, "edit": project.on_edit,
                    "view": project.on_view, "width": project.on_width,
                    "lua": project.on_lua, "cursor": project.on_cursor,
                    "scan": project.on_scan, "caretDebug": project.on_caret_debug,
                    "caretMap": project.on_caret_map,
                    "caretElements": project.on_caret_elements}.get(kind)
                if handler_fn:
                    await handler_fn(ws, msg)
            except Exception as e:          # one bad message must not end the connection
                log("error:", repr(e))
                if project:
                    await project.status(f"helper error: {e}", False)
    except websockets.ConnectionClosed:
        pass                                # the Overleaf tab was closed
    finally:
        if project:
            await project.leave(ws)
            if not project.clients:
                PROJECTS.pop(project.project, None)
    log("extension disconnected")


def quit_now():
    """kill / Ctrl+C: stop TeXpresso and exit at once (don't wait for
    the Overleaf tabs to close their connections)"""
    for project in PROJECTS.values():
        project.kill_group()
    log("stopped")
    os._exit(0)


async def main():
    if not Path(TEXPRESSO).exists():
        log(f"TeXpresso not found at {TEXPRESSO} (set TEXPRESSO=...)")
        sys.exit(1)
    ROOT.mkdir(parents=True, exist_ok=True)
    async with websockets.serve(handler, "127.0.0.1", PORT, max_size=2**28,
                                origins=[f"chrome-extension://{EXTENSION_ID}"]):
        log(f"Overleaf Live helper on ws://127.0.0.1:{PORT}")
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            asyncio.get_running_loop().add_signal_handler(sig, quit_now)
        await asyncio.Future()      # runs until a signal


if __name__ == "__main__":
    asyncio.run(main())
