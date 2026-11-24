# Changelog

## 0.1.0 (2026-11-24)

First release.

- Compiles Overleaf projects locally with TeX Live 2026 in WebAssembly: pdfLaTeX, XeLaTeX and LuaLaTeX, with
  BibTeX, Biber and makeindex. Overleaf's compile options apply (main document, compiler, draft mode, stop on
  first error).
- The PDF, log, error markers, SyncTeX and the download button work in Overleaf's own interface.
- A live copy of the project follows every edit, including collaborators' edits, so compiling needs no
  request to the server.
- Packages and fonts outside the bundle are downloaded once and cached; projects keep their last build
  across browser restarts.
- Falls back to the server, with a notice, when a project needs something the local engine can't do
  (shell escape, missing packages or fonts), when a local compile takes too long, or when LocaLeaf itself
  fails. LaTeX errors in your document are shown as usual.
- While a tab warms up, a slow first compile also runs on the server, and the first PDF wins.
- Popup: switch per site, local or server per project, engine status and restart, live status, statistics,
  all settings. Progress indicator next to the download button; toolbar badge while busy.
