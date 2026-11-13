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

Messages (JSON, one per WebSocket message)
  extension -> helper
    {"type": "hello", "project": id, "main": "main.tex", "lua": bool}
    {"type": "project", "zip": base64}       the whole project
    {"type": "edit", "path": "main.tex", "text": "..."}
    {"type": "view", "first": n, "last": n}  the visible pages (from 0)
    {"type": "width", "width": px}           picture width in pixels
    {"type": "lua", "on": bool}
  helper -> extension
    {"type": "versions", "extension": "0.1.1"}   the version install.sh put
                                             in the Windows folder
    {"type": "status", "text": "...", "busy": bool}
    {"type": "page", "page": n, "count": n, "done": bool, "png": base64}
    {"type": "count", "count": n, "done": bool}   pages so far; done: all
    {"type": "errors", "lines": ["...", ...]}
"""
import asyncio
import base64
import io
import json
import os
import re
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


class Session:
    """One Overleaf project: its folder, TeXpresso and the background compile."""

    def __init__(self, ws):
        self.ws = ws
        self.project = None
        self.dir = None
        self.main = "main.tex"
        self.lua = False
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

    async def send(self, msg):
        try:
            await self.ws.send(json.dumps(msg))
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
        self.reader = asyncio.create_task(self.read_texpresso(self.proc))
        await self.command(f"(export-png {sexp_string(str(self.export_dir))} {int(self.width)})")
        await self.command(f"(export-range {self.first} {self.last})")
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
        page_re = re.compile(r'^\(page-image (\d+) (\d+) (\d) "(.*)"\)$')
        count_re = re.compile(r'^\(page-count (\d+) (\d)\)$')
        append_re = re.compile(r'^\(append out (\d+) "(.*)"\)$')
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
                                 "done": done, "png": base64.b64encode(data).decode()})
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
    async def on_hello(self, msg):
        project = re.sub(r"[^A-Za-z0-9_-]", "", str(msg.get("project", "")))
        if not project:
            return await self.status("no project id", False)
        self.project = project
        self.dir = ROOT / project
        self.dir.mkdir(parents=True, exist_ok=True)
        self.main = msg.get("main") or "main.tex"
        self.lua = bool(msg.get("lua"))
        await self.status("waiting for the project files", True)

    async def on_project(self, msg):
        if not self.dir:
            return
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
        else:
            await self.start_texpresso()
        if self.lua and not list(self.dir.glob("*.luakeys")):
            self.last_edit = 0
            self.schedule_lua()

    async def on_edit(self, msg):
        if not self.dir:
            return
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

    async def on_view(self, msg):
        self.first = max(0, int(msg.get("first", 0)))
        self.last = max(self.first, min(self.first + 20, int(msg.get("last", self.first))))
        await self.command(f"(export-range {self.first} {self.last})")

    async def on_width(self, msg):
        self.width = max(200, min(4000, int(msg.get("width", 1000))))
        if self.export_dir:
            await self.command(f"(export-png {sexp_string(str(self.export_dir))} {self.width})")

    async def on_lua(self, msg):
        self.lua = bool(msg.get("on"))
        if self.lua:
            self.last_edit = 0
            self.schedule_lua()

    async def run(self):
        handlers = {"hello": self.on_hello, "project": self.on_project,
                    "edit": self.on_edit, "view": self.on_view,
                    "width": self.on_width, "lua": self.on_lua}
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                    handler = handlers.get(msg.get("type"))
                    if handler:
                        await handler(msg)
                except Exception as e:      # one bad message must not end the session
                    log("error:", repr(e))
                    await self.status(f"helper error: {e}", False)
        except websockets.ConnectionClosed:
            pass                            # the Overleaf tab was closed
        finally:
            await self.stop_texpresso()
            if self.lua_task:
                self.lua_task.cancel()


SESSIONS = set()


def installed_extension_version():
    """written by install.sh: the version in the Windows extension folder"""
    try:
        return (Path.home() / "overleaf-live/extension-version").read_text().strip()
    except OSError:
        return ""


async def handler(ws, path=None):
    log("extension connected")
    await ws.send(json.dumps({"type": "versions", "extension": installed_extension_version()}))
    session = Session(ws)
    SESSIONS.add(session)
    try:
        await session.run()
    finally:
        SESSIONS.discard(session)
    log("extension disconnected")


def quit_now():
    """kill / Ctrl+C: stop TeXpresso and exit at once (don't wait for
    the Overleaf tabs to close their connections)"""
    for session in SESSIONS:
        session.kill_group()
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
