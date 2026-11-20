# Chrome Web Store: what to put in each field

Build the ZIP with `./pack-store.sh` (it removes the `key` field and sets the store name). The pictures are in `store/`.

## Package

- Upload: `overleaf-live-<version>.zip`

## Store listing

- **Name** (from the manifest): Live Preview for Overleaf (TeXpresso)
- **Summary** (from the manifest): Live LaTeX preview for Overleaf, typeset by TeXpresso in your browser. Not affiliated with Overleaf.
- **Category**: Tools (Productivity)
- **Language**: English
- **Store icon**: `store/icon128.png` (128 × 128)
- **Screenshots** (1280 × 800): `store/screenshot-1.png` … `store/screenshot-4.png`
- **Small promo tile** (440 × 280): `store/promo-small-440x280.png`
- **Homepage URL / Support URL**: https://github.com/silasm01/overleaf-live (only if the repo is public)

### Description

```
See your Overleaf document change while you type.

This extension puts a live preview next to the Overleaf editor. The preview is typeset by TeXpresso, an incremental TeX engine, that runs in your browser (WebAssembly). A change shows on the page in approx. 0.2–0.4 s, without a full recompile.

What you get
• Live pages: the pages change as you type. All pages load at the start, so links in the table of contents work.
• A caret on the page: an orange caret shows where your editor cursor is, also in tables, math and TikZ pictures.
• Click and double-click: a click on the page moves the editor cursor there. A double-click on a value (a number, a label, a table cell, math) opens a small edit box. The editor and the page change at the same time.
• Collaborators: edits from other people wait until they are stable, so an unfinished edit does not break your preview. If the document has an error, the last good pages stay.
• Overleaf's own toolbar: page numbers, zoom and dark mode work on the live pages. "PDF in separate tab" also works.

Extras for the latex-templates modules (K-maps, truth tables, state machines, circuits and logic gates)
• Double-click a K-map cell for a 0 / 1 / D menu, a gate for its type, a state for its name.
• A toolbar over a module adds states, transitions, gates, components and implicants.
• "+ Insert" puts a blank module at the editor cursor.

How to use it
1. Open a project on overleaf.com.
2. Click "Live" at the bottom right of the PDF pane.
The first start downloads the LaTeX packages that the document needs from a public TeX Live mirror and builds the LaTeX format (approx. 10–15 s, plus the downloads). They are kept in the browser, so later starts take approx. 3 s.

Requirements and limits
• The document must compile with XeLaTeX (most documents do). Fonts by file name only (for example \setmainfont{texgyrepagella}[Extension=.otf]); font names through fontconfig are not supported yet.
• Overleaf must have compiled the project one time (its PDF toolbar must be there).
• The extension uses an unofficial Overleaf hook for extensions. An Overleaf update can break it.
• Optional: a helper program for WSL on Windows can typeset with your own TeX Live installation. The browser engine is the default and needs nothing else.

Privacy
Your documents stay on your computer. The extension sends nothing to the developer and has no analytics.

This extension is not made by Overleaf and is not affiliated with Overleaf. TeXpresso is by Frédéric Bour (MIT license). The rendering uses MuPDF (AGPL-3.0).
```

## Privacy practices

- **Single purpose**:
  ```
  Show a live, typeset preview of the LaTeX document that is open in the Overleaf editor, and connect the preview to the editor (cursor position, click to go to the source, small edits on the page).
  ```
- **Permission: storage**:
  ```
  Saves the user's settings (engine choice, settings for each Overleaf project, debug panel options) in chrome.storage.local.
  ```
- **Permission: unlimitedStorage**:
  ```
  The TeX engine runs in the browser. It needs the LaTeX packages, fonts and a compiled LaTeX format, often several hundred MB. They are kept in the extension's private file storage (OPFS) so that they are not downloaded again at each start.
  ```
- **Permission: offscreen**:
  ```
  The WebAssembly TeX engine runs in Web Workers that an offscreen document starts. A service worker cannot keep a long-running engine, and the engine must keep running while the user types.
  ```
- **Host permissions** (ftp.math.utah.edu, ftp.tu-chemnitz.de, mirrors.tuna.tsinghua.edu.cn):
  ```
  These are public TeX Live mirrors. The engine downloads the LaTeX packages and fonts that the document needs from them. Only the package file name is sent.
  ```
- **Content scripts on https://www.overleaf.com/project/*** (if the form asks):
  ```
  Reads the text and cursor of the Overleaf editor and shows the preview pages in the PDF pane. Gets the project's files from Overleaf's own ZIP download, with the user's session.
  ```
- **Are you using remote code?** No.
  ```
  All JavaScript and WebAssembly is in the package. The files downloaded from TeX Live mirrors are LaTeX packages and fonts (data) that the bundled TeX engine typesets, like a document; they are never run as JavaScript or WebAssembly.
  ```
- **Data usage**: tick nothing (the extension does not collect or transmit user data). Tick the three certifications.
- **Privacy policy URL**: a public copy of `PRIVACY.md`.

## Distribution

- **Payments**: Free
- **Visibility**: Unlisted
- **Regions**: All regions

## Test instructions (for the reviewer)

```
1. Sign in to overleaf.com and open any project (for example a new "Blank project").
2. Click "Live" at the bottom right of the PDF pane. The first start downloads LaTeX packages (approx. 15–60 s); then the pages show.
3. Type in the editor: the page changes; the orange caret follows the cursor.
4. Double-click a word or number on the page: the editor cursor goes to it (a number opens a small edit box).
No account or server of the developer is used. The WSL helper option is not needed.
```
