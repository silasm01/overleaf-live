# Overleaf Live (prototype)

Live preview for Overleaf. TeXpresso typesets the page while you type, and a
Chrome extension shows the page over Overleaf's PDF pane.

There are two engines. You select one in the Live menu (**Engine**):
- **In the browser** (default, since version 0.5.0): TeXpresso runs as
  WebAssembly in Chrome. Nothing to install in WSL. Since version 0.6.0,
  TeX Live packages come from the internet when a project needs them. See "Browser engine" below
  for what it can not do yet.
- **WSL helper**: TeXpresso runs in WSL on your PC (sections 1-4).

```
Overleaf tab (Chrome)                     WSL (Ubuntu)
  page.js     reads each edit       ┐
  content.js  "Live" viewer, zip    ├──>  helper  ──>  TeXpresso (XeLaTeX)
  background.js WebSocket           ┘ <──  PNG of the page you look at
```

Folders:
- `extension/`: the Chrome extension
- `helper/overleaf_live.py`: the helper (runs in WSL)
- `texpresso/png-export.patch`: changes TeXpresso so it renders the visible pages to PNG files, finds `.tex` files in `-I` folders and pictures in TeX Live, draws transparency (TikZ `opacity`) and hairlines of at least one pixel, and reports the end of the document
- `extension/engine/`: the browser engine (WebAssembly TeXpresso, built from `wasm/`)
- `wasm/`: how to build TeXpresso for WebAssembly, and its tests
- `install.sh`: installs everything in WSL
- `update.sh`: gets the newest version from GitHub and installs it

## 1. Install WSL (one time)

1. Open **PowerShell as administrator**. Type:
   `wsl --install -d Ubuntu-24.04`
2. Restart Windows when it tells you to.
3. Ubuntu opens. Type a user name and a password. Keep the password: `install.sh` asks for it.

## 2. Get this repo in WSL (one time)

The repo is private, so WSL must sign in to GitHub. In Ubuntu:

```
sudo apt install -y gh
gh auth login          # GitHub.com, HTTPS, "Login with a web browser"
gh auth setup-git      # git uses this login for pull
git clone https://github.com/silasm01/overleaf-live ~/overleaf-live-src
```

## 3. Install (one time)

```
cd ~/overleaf-live-src && bash install.sh
```

The script installs the missing Ubuntu packages, TeX Live 2026 (approx. 2–3 GB, 20–40 minutes), TeXpresso, the helper, and the extension in `C:\Users\<you>\overleaf-live-extension`. It also starts the helper. At the end it must show `OK: TeXpresso works`.

Then, in Chrome:
1. Go to `chrome://extensions` and turn on **Developer mode** (top right).
2. Remove any older Overleaf Live.
3. Click **Load unpacked** and select `C:\Users\<you>\overleaf-live-extension`. Do not move this folder: Chrome loads the extension from it, and `update.sh` puts new versions in it.

The extension ID must be `ocdaihokchcbanejcpclejmpaobbafcj`. The helper accepts connections only from this ID.

## 4. Start the helper when Windows starts (one time)

Open **PowerShell** (not as administrator). Type (one command):

```powershell
Register-ScheduledTask -TaskName "Overleaf Live helper" -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-WindowStyle Hidden -Command "wsl.exe -d Ubuntu-24.04 --exec bash -lc ~/overleaf-live/start.sh"')
```

To remove it later: `Unregister-ScheduledTask -TaskName "Overleaf Live helper"`.

## Update

In Ubuntu:

```
~/overleaf-live-src/update.sh
```

It gets the newest version from GitHub, rebuilds TeXpresso only when its patch changed, and restarts the helper. The extension reloads itself the next time it connects to the helper. Then reload the Overleaf tab (the viewer says so).

## Use it

1. Open an Overleaf project. Click **Live** (bottom right of the PDF pane). The live pages cover Overleaf's PDF.
2. Use Overleaf's own PDF toolbar: the page number box and ˄ ˅, zoom − / + and the zoom menu (fit to width, fit to height, percentages), and the button that inverts the PDF colours. While Live is on, they work on the live pages. Ctrl + mouse wheel and Ctrl + / − / 0 / 9 also work on the live pages.
3. The pages are one under the other. TeXpresso typesets up to the last page in view, so `/ 3+` means "at least 3 pages". The pages under the visible ones are typeset when you scroll to them.
4. The **Live** button shows the status: a green dot is live, an orange dot is busy (typesetting, sending files, Lua), and a red dot shows the number of LaTeX errors. Click it for the menu:
   - the status and the LaTeX errors with line numbers
   - **Lua results** (WSL helper only; in the browser engine they are always on): for calc and fsm. This runs a normal compile (`latexmk -xelatex -shell-escape`) on your PC approx. 2 seconds after you stop typing. Then TeXpresso shows the new results. **Shell escape can run any command on your PC.** Turn it on only for projects you trust (yours). The setting is saved for each project.
   - **Sync files**: sends all project files again. The extension does this automatically when you open another file. Overleaf allows 10 downloads a minute, so the extension waits at least 10 seconds between syncs.
   - **Turn off Live**: Overleaf's own PDF and toolbar again.
5. **Cursor in the PDF (SyncTeX)**: an orange caret on the live page shows where the editor cursor is. It moves when you move the cursor or type. The PDF scrolls only when the caret is out of view. A **double-click** on a live page moves the editor cursor to that text, and opens its file when it is another file. Overleaf's two arrow buttons between the editor and the PDF still use Overleaf's own compiled PDF.
   - In normal text, the caret is correct to about one character. Inside a command argument (for example `\emph{...}` or a heading), the position is only approximate in that argument. Math is one position for each formula.
   - A line that typesets no text (for example `\begin{figure}`) has no position: the caret becomes pale.
   - A double-click can open only a file that is visible in the file tree: open its folder first.
6. **PDF in a separate tab**: use Overleaf's **Layout → PDF in separate tab**. The editor tab sends the edits, and the separate tab shows the live pages with the same toolbar. Turning Live on or off in one tab changes both. You can drag the tab out to its own window.

The project's copy on your PC is in `~/.overleaf-live/<project id>/` in WSL.

## Browser engine

Load the extension folder (`extension/`, or the copy that `install.sh` puts in
Windows) as an unpacked extension, as before. Then select **Engine → In the
browser** in the Live menu (the default).

- TeX Live 2025 (the version that Overleaf uses) comes from the internet
  when a project needs it: first the package index (approx. 3 MB), then
  each TeX Live package that the project uses. Chrome keeps all of it
  (Origin Private File System of the extension), so each package comes only
  one time, for all projects and all compilations.
- The first start in Chrome downloads the packages for the XeLaTeX format
  and builds the format (approx. 10-15 s). Later starts take approx. 3 s.
  A new package (for example a new `\usepackage`) adds approx. 0.1-1 s one
  time.
- An edit shows in approx. 0.15-0.4 s (native TeXpresso: 0.1-0.15 s).
- **Second pass, BibTeX, biblatex:** 2 s after you stop typing, TeXpresso
  goes on to the end of the document, and its `.aux`, `.toc`, `.out`, ...
  files go back in as inputs (as latexmk does). So the table of contents,
  `\ref`, `\pageref` and "Page n / N" are correct. If the document uses
  BibTeX (`\bibliography`), BibTeX runs in the extension and makes the
  `.bbl`. For biblatex (Biber), the extension uses the `.bbl` of Overleaf's
  last compile: click **Recompile** in Overleaf after you add a citation.
- **Lua results** (calc, fsm) are always on and update while you type. A Lua
  5.4 sandbox in the extension runs them; it has no shell and no access to
  your PC. The engine reports a restricted shell escape that allows only
  `kpsewhich` and `texlua`. For this, the project needs the luabridge.tex of
  latex-templates from 14 November 2026 or later (it runs texlua also with a
  restricted shell escape when texlua is allowed).
- **Limits for now:**
  - Fonts by file name only (`\setmainfont{texgyrepagella}[Extension=.otf, ...]`
    or a font file in the project). Font names through fontconfig
    (`\setmainfont{TeX Gyre Pagella}`) are not supported yet.
  - One project at a time: a second project's tab takes over the engine.

## Requirements for a project

- It must compile with XeLaTeX. For your template, this needs the XeLaTeX changes in `setup.tex`, `modules/lib/luabridge.tex`, `modules/lib/luabridge.lua` and `modules/profile.tex` (in the latex-templates repo since 13 November 2026).
- Folders that `latexmkrc` adds to `TEXINPUTS` (for example `template//` in the latex-templates repo) are found too.
- The main file is `main.tex`, or else the first `.tex` file at the top that has `\documentclass`.

## Limits of this prototype

- Overleaf's toolbar must be there: it shows when Overleaf has compiled a PDF of the project at least once.
- After an edit, pages that are not in view are updated when you scroll to them.
- The extension uses Overleaf's unsupported hook for extensions (`UNSTABLE_editor:extensions`). An Overleaf update can break it.
- The extension reads edits only for the open file, but these include edits by collaborators. Changes in other files come with the next Sync.
- WSL helper: TeXpresso does not run BibTeX. With Lua on, the normal compile makes the `.bbl` file, and TeXpresso uses it. (The browser engine runs BibTeX itself; see "Browser engine".)

## If it does not work

| Status in the viewer | What to do |
|---|---|
| `helper not running (start it in WSL)` | In Ubuntu: `~/overleaf-live/start.sh &`, then look at `~/overleaf-live/helper.log`. To stop it: `pkill -f overleaf-live/start.sh; pkill -f overleaf_live.py`. |
| The helper runs, but Chrome cannot connect | Make a file `C:\Users\silas\.wslconfig` with the two lines `[wsl2]` and `networkingMode=mirrored`. Then type `wsl --shutdown` in PowerShell and start Ubuntu again. |
| `can't find this file in the file tree` | Open the folder of the file in Overleaf's file tree. |
| `could not get the project files` | Wait 1 minute (Overleaf's limit), then click Sync. |
| Red errors at the top | These are the LaTeX errors from TeXpresso, with line numbers. |
