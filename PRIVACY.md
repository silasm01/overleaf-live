# Privacy policy: Live Preview for Overleaf (TeXpresso)

Last change: 20 November 2026

This extension shows a live preview of the LaTeX document that is open in Overleaf. It is not made by Overleaf and is not affiliated with Overleaf.

## What the extension reads

- The text in the Overleaf editor of the project that is open, and the files of that project. The extension gets the project files from Overleaf's normal "download as ZIP" address, in your browser, with your own Overleaf session.
- The position of your cursor in the editor.

## Where your data goes

- **Your documents stay on your computer.** The extension typesets them in your browser (the browser engine) or, if you choose it, in a program on your own PC (the WSL helper at `127.0.0.1`). It does not send your documents, your Overleaf account data or any other personal data to the developer or to any other party.
- **TeX Live downloads.** When a document needs a LaTeX package or font that is not on your computer yet, the extension downloads it from a public TeX Live mirror (`ftp.math.utah.edu`, `ftp.tu-chemnitz.de` or `mirrors.tuna.tsinghua.edu.cn`). The request contains only the name of the package file. The mirrors can see your IP address, as with any download.
- **No analytics, no tracking, no advertising.** The extension has no accounts and no server of its own.

## What the extension stores

In your browser only:

- your settings (for example the engine, and the settings for each project) in the extension's local storage;
- the downloaded TeX Live packages and fonts, and the compiled LaTeX format, in the browser's private file storage for the extension, so that they are not downloaded again.

When you remove the extension, Chrome deletes this data.

## Sale and use of data

The developer does not sell data, does not transfer data to third parties, and does not use data for any purpose other than the live preview.

## Contact

Silas — open an issue at https://github.com/silasm01/overleaf-live/issues or ask the person who sent you the link.
