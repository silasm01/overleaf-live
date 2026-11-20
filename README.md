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
   - **Report a problem**: saves a file with what happened in the last minute (edits, clicks, the engine's answers, the pages in view and the project files), to send with a bug report. Also **Alt+Shift+R**. The file has the text of the project. See `test/README.md`.
   - **Sync files**: sends all project files again. The extension does this automatically when you open another file. Overleaf allows 10 downloads a minute, so the extension waits at least 10 seconds between syncs.
   - **Turn off Live**: Overleaf's own PDF and toolbar again.
5. **Cursor in the PDF (SyncTeX)**: an orange caret on the live page shows where the editor cursor is. It moves when you move the cursor or type. The PDF scrolls only when the caret is out of view. A **double-click** on a live page moves the editor cursor to that text, and opens its file when it is another file. Overleaf's two arrow buttons between the editor and the PDF still use Overleaf's own compiled PDF.
   - The caret is on the glyph of each visible character: in normal text, in `\textbf{...}`, `\emph{...}`, `\texttt{...}`, in your own commands (for example `\file{...}`), in table cells and at line breaks. The source characters are aligned to the glyphs on the page by the glyph identity, so a command or an arrow (→) before a word does not move the caret off the word..
   - A part of the source that does not print its own characters, for example `\infty`, `\alpha`, `\ref{...}`, `\cref{...}` or `\includegraphics{...}`, gets an orange box around what it prints (the symbol, the number or the picture). When the editor cursor is in that part, the caret is at the start of the box. Directly after the part, the caret is at the end of the box. When some parts print one glyph each (for example `$\alpha\beta$`), each part gets its own box. A picture shows only its box, without a caret line.
   - Commands that print nothing (for example `\textbf`, `\label{...}`, `\hspace{...}`) do not move the caret: it stays between the visible characters.
   - A line that typesets no text (for example `\begin{figure}`) has no position: the caret becomes pale.
   - **TikZ and circuitikz**: each element of a picture gets a box: a path (`\draw`, `\fill`, `\node`, … up to `;`), a node, a `to[...]` part (for example a resistor and its label), a scope and the picture. When the editor cursor is in the source of an element, the box of the smallest element around it shows (only the box, no caret line); text in a node keeps the normal caret. A click on a line or a shape puts the editor cursor at the start of its source (a click on a resistor: before its `to[R=...]`).
     - The live preview adds the markers for this itself, when a document loads TikZ (a `pgf.cfg` that only the live preview reads). Your files and the Overleaf PDF do not change.
     - Code that TeX writes to a file and reads again (for example the `usage` environment of the latex-templates catalog, which copies its body to `main-usage.tex` and typesets it): the engine finds the lines of the source file that the file is a copy of, so the caret, the boxes and clicks go to the source file. The caret shows the output, not the listing.
     - An environment that collects its body and draws it at its end (for example `circuit` of latex-templates) has one box for all of it: TeX gives only the line of `\end{...}`. A click on it goes to its `\begin{...}`.
   - A double-click can open only a file that is visible in the file tree: open its folder first.
   - **Quick edit**: double-click a value in the live PDF, for example the label R₁ of a circuit part, a node text, or a value in `{...}`, `[...]` or `$...$`. The editor selects its source, and a small edit box opens under it. While you type, the editor and the page change at once; **Enter** (or a click elsewhere) keeps the text, **Esc** puts the old text back, **Tab** / **Shift+Tab** select the next / previous argument in the box (for example from the value to the unit of `\qty`). If the source changed in the meantime, nothing is written. What a double-click edits:
     - a value in `{...}` or `[...]` (in a `key=value` list, the value);
     - math: the whole `$...$`, or only an argument in it (`\frac{a}{b}`, `x_{10}`, `\sqrt{2}`, `\text{...}`);
     - an argument of a short command call (one line, at most 80 characters): the box shows the whole call with the clicked argument selected, for example `\qty{2.2}{\kilo\ohm}`;
     - a cell of a table (the text between `&` and `\\`);
     - a line of a plot: the function of `\addplot ... {x^2};` or of `plot (\x, {sin(\x r)})`.
     - A value that shows in several places (for example one value for many cells) gets no edit box: the editor only selects it, because an edit changes all places.
     - Where there is no field (normal text), a double-click moves the cursor to the clicked character.
   - **Modules**: modules can mark what they draw (see `olive-live.tex` below). Then a double-click on a circuit part edits its type (`R`, `C`, ...), on a gate its type (`and`, `or`, ...), on a gate input its signal, on a state of a state machine its name (in all places of the machine: the state and the transitions to it), on a `calc` value its `\setvar`, on a curve of `cplane` its numbers. A double-click on a K-map cell opens a small menu with **0**, **1** and **D**: the choice changes `\minterms{...}` and `\dontcares{...}` (a list is added if there is none, and removed if it becomes empty). Where the module gives a list of values (gate types, circuit parts), the edit box shows them as buttons under the box: a click on one saves it, and you can still type any other value.
     - **Marker API** for modules: the live preview has a file `olive-live.tex` (Overleaf does not). A module reads it with `\InputIfFileExists{olive-live.tex}{}{}` and then marks what it draws with `\olivebegin{name}{index}{action} ... \oliveend` (the index-th call of `\name` in the environment around the line), `\olivebeginat{\olivehere}{name}{index}{action}` (for a call elsewhere, for example from Lua) or the TikZ path key `olive={name}{index}{action}`. Actions: `arg:N` (edit the N-th `{}` argument), `key:N` (its first key), `paren:N` (the N-th `()` argument), `opt:N` (the N-th `[]` argument), `entry:N:K` (in the N-th `{}` argument, a list `k: v, k: v`, the value of the entry with key K; `entry:N:K:P`: its P-th part of `a/b`), each with an optional list of values (`arg:1|and,or,not`); `name:N` (as `arg:N`, but a name: an edit changes it in all places of the environment); `toggle:LIST:V` (add V to `\LIST{...}` or remove it); `cell:N:V` (a K-map cell N with the value V: the menu 0, 1, D). Markers can be inside each other: a double-click uses the smallest marker at the point (for example the name, code and output of an FSM state inside the marker of the whole state). Text that a module writes from Lua (not in the source) edits the marker's field. Use `\providecommand` for the commands, so the module works without the file.
   - **Mouse and keys in the live pages**:
     - The mouse cursor shows what is under it: a text cursor on text, a pointing hand on a link, a grab hand (and a thin orange box) on what a double-click edits.
     - **Click**: moves the editor cursor to the clicked character. **Click on a link** (contents, `\ref`, `\cite`, URLs): goes to its target (a URL opens in a new tab). **Double-click**: quick edit (below).
     - **Drag** over text selects it; **Ctrl+C** copies it. **Ctrl+F** (with the mouse over the pages) finds text in the preview: Enter / Shift+Enter for the next / previous hit, Esc closes.
     - **Ctrl+wheel** or pinch: zoom around the mouse. **Ctrl+Z** / **Ctrl+Shift+Z** in the pages: undo / redo in the editor (for example a quick edit).
     - A thin orange bar at the top of the viewer shows that the engine works after an edit (green when it is done without errors). Errors show at the top left with file and line; a click on one goes to that line.
   - **Debug panel**: press **Alt+Shift+G** in the Overleaf tab. It has these tools. When you close the panel, the marks on the pages stay. The settings stay for each project, also after a reload.
     - **Caret map**: marks the caret position of each character of the 5 lines around the editor cursor (2 lines before, the cursor line, 2 lines after), one colour for each line, and the boxes (dashed orange). Use it to see quickly where the caret is wrong, without selecting text. Each line is calculated as its own caret would be, so the marks are where the caret really goes.
     - **Whole page** (under Caret map): marks all source lines on the pages in view and on the page of the caret (at most 6 pages), from all files. A page gets its map when it comes into view or when the caret goes to it, and again 1 second after it is typeset again. It does not follow each cursor move on the same page.
     - **Boxes**: the boxes on the pages in view and the page of the caret. A check box for each type:
       - **Top parents** (red), **Intermediary** (orange), **Lowest** (blue): the elements (TikZ pictures and scopes, paths, nodes, `to[...]` parts, plots of `\addplot` (L), module markers (c)) by their level. A parent is the smallest element of a lower depth that contains the box. The label is the kind and the source line. Dashed: an element whose source is not in the project.
       - **Normally editable** (green, dotted): text that a double-click edits in an edit box.
       - **Specially editable** (purple, dotted): module markers with a menu, a value list (for example K-map cells) or a name.
       The engine checks each character of the page for the editable boxes, only while one of the two is on.
       **Colour by**: *level* (the colours above) or *kind* (pictures red, paths blue, nodes green, `to[...]` purple, module markers orange).
     - **Timings**: *start* (to the first page, with the steps: packages, engine, format, first page), *live edit* (from an edit to the first new page, with the engine ticks and their time), *page picture* (display list, draw, PNG, page map, in ms), *frames* (browser engine: engine ticks per second, average and maximum ms per tick, % of the time busy), *deep* (from an edit to the end of the document, with the extra passes), *Lua* (WSL: the latexmk run) and *editable* (time for the editable boxes of a page). *Latency* (last and median of the last 30): key press → new picture on the screen, double-click → edit box, hover → cursor (when the engine must answer), cursor → caret (from the cache or the engine), and whether the cached caret was the same as the engine's.
     - **Predict the caret while typing** (on by default): after a key, the caret moves at once by about one character width (from the known carets of its line); the engine's answer then puts it in its exact place. An answer for an older cursor position is not shown.
     - **Instant feedback (test)**: off by default. A double-click outlines what it edits at once, and a value chosen in a menu shows on the page at once, until the new picture comes.
     - **Caret**: the editor cursor (file, line, column), the caret that the engine sent (page, position in points, box) and the time to the answer.
     - **Engine log**: the messages of the browser engine (TeX Live downloads, restarts, errors). **Copy** puts them on the clipboard for a bug report. The WSL helper writes its log in its own terminal.
   - **Insert**: the **+ Insert** button at the top right of the preview opens a menu of blank modules: Karnaugh map (3 or 4 variables), truth table (2 or 3 inputs), state machine (Moore or Mealy), electric circuit, logic gates, complex plane, calculation with units, code listing, responsibility table, figures side by side. The blank goes in at the editor cursor on its own lines (after the cursor's line if it has text; a selection is replaced), and the editor cursor goes to the first thing to fill in. If the file does not load the module yet, its name is added to `\usemodule{...}` (or a `\usemodule` line after `\input{setup}`); in a file without the preamble, the status line says to add it in the main file.
   - **Module toolbar**: when the editor cursor is in a state machine (also on its `\fsmdiagram` / `\fsmtable` line), a circuit, a Karnaugh map or a truth table, a toolbar shows above it on the page. Its buttons open small forms that write the change into the source: state machine: + State (next free name and code, transitions to itself), Transition (from, input, to, Mealy output), Remove state (transitions to it become loops); logic gates: + Gate, + Output, Remove gate; electric circuit: + Node, + Component (between two nodes, type, label), + Wire, + Ground; Karnaugh map: + Implicant, Remove implicant; truth table: + Input (each row becomes two), + Output (empty column). Enter: OK, Esc: cancel. Placing by clicking on the page is on the TODO list.
   - **Speed**: when the pages in view are done, the engine sends a cache of each page in view: what a double-click edits (so the hover cursor changes at once) and the caret of each character (so the caret moves at once with the editor cursor; the engine's answer then corrects it, if it is different). An edit makes the cache old. The editor sends the first change and each cursor move at once. The engine encodes page pictures as fast PNGs (grey pages as one byte a pixel). All pages are loaded, as if you had scrolled past them: the engine typesets the pages in view first and then the rest of the document at once (after an edit: after 2 s without edits), and it draws a page again only when its DVI code changed.
   - **Collaborators**: when other people edit the file that is open, their edits show in the editor at once, but the live preview waits for them: until they stop typing for 2 seconds and their braces, `$` and `\begin`/`\end` are balanced. While edits wait, the Live button says *collaborator edit held*, and the menu has **Show collaborator edits now**. Your own edits go to the preview at once in the meantime. If released edits give a new LaTeX error in their lines (in 10 seconds), they are held again until they are fixed (only when you did not edit since then). When the document has an error and gives fewer pages or none, the last good pages stay, pale, with the note "Last good version". Other files (not open here) come with the project zip: every 2 minutes while collaborators are active (Overleaf allows at most 30 project downloads an hour), and only the changed files are written.
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
- **Fatal TeX errors** (for example an open `{` in `\textbf{` or `\frac{1}{`,
  or a package name that is not complete yet) stop only the current run, as
  in the WSL helper: the pages before the error stay, and the next edit goes
  on from an earlier snapshot (approx. 0.1-0.5 s, no restart of the engine).
- **Limits for now:**
  - Fonts by file name only (`\setmainfont{texgyrepagella}[Extension=.otf, ...]`
    or a font file in the project). Font names through fontconfig
    (`\setmainfont{TeX Gyre Pagella}`) are not supported yet.

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

## Tests

`test/run.sh --templates ../latex-templates` runs the tests of the browser
engine and the viewer in headless Chrome (typing errors, fast fixes, clicks
and caret, selection, problem reports). All tests must pass before a new
version is published. See `test/README.md`.

## Chrome Web Store

`./pack-store.sh` makes the ZIP for the Chrome Web Store (without the `key` field, with the store name "Live Preview for Overleaf (TeXpresso)"). `STORE.md` has the text for each field of the developer dashboard, `store/` has the pictures, and `PRIVACY.md` is the privacy policy.

## If it does not work

| Status in the viewer | What to do |
|---|---|
| `helper not running (start it in WSL)` | In Ubuntu: `~/overleaf-live/start.sh &`, then look at `~/overleaf-live/helper.log`. To stop it: `pkill -f overleaf-live/start.sh; pkill -f overleaf_live.py`. |
| The helper runs, but Chrome cannot connect | Make a file `C:\Users\silas\.wslconfig` with the two lines `[wsl2]` and `networkingMode=mirrored`. Then type `wsl --shutdown` in PowerShell and start Ubuntu again. |
| `can't find this file in the file tree` | Open the folder of the file in Overleaf's file tree. |
| `could not get the project files` | Wait 1 minute (Overleaf's limit), then click Sync. |
| Red errors at the top | These are the LaTeX errors from TeXpresso, with line numbers. |
