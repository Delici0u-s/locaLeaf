# LocaLeaf TODO

## Requested (2026-11-23)

- [ ] **Popup UI redesign.** The current popup is a plain form. Needs a proper switch for local/server
  compiling, a clear status area, and settings grouped and explained instead of a raw key list.
  - **Progress chip position:** a setting for where the chip goes: a screen corner, dragged into place in the
    page, or inline in Overleaf's PDF toolbar (in the empty space right of the download button, which sits
    right of Recompile). Inline needs a robust way to find that toolbar.
- [x] **Progress / first-load indicator in the page.** A status chip (after `statusDelayMs`) shows what LocaLeaf
  is doing: loading the project (docs/files done), starting the engine, TeX pass n, downloads with MB and %,
  plus the elapsed seconds. The same lines go to the console.
- [x] **Compile statistics.** Local vs. server counts, average and last time, per project and overall, in the
  popup (stored by the background). Shown plainly for now; part of the popup redesign.
- [ ] **A real project compiles on the server but hangs locally** (the mirror loads, then no compile result).
  The progress output now shows where it is; a time limit falls back to the server. Waiting for the console
  output from that project to find the cause.

## Robustness

- [x] Time limit for local compiles, then fall back to the server (`localTimeoutSeconds`, default 240).
- [x] Size limit for CTAN package downloads (`engine.maxCtanPackageMB`, default 60) and a download timeout.
- [ ] Out-of-memory in the engine (untested).
- [ ] `minted` / shell-escape: confirm it falls back to the server cleanly.
- [ ] Root cause of the intermittent "TeX capacity exceeded" after fetching fonts (worked around by a retry).

## Nice to have

- [ ] Packaged release (zip of `dist/`) so installing doesn't need Node.
- [ ] Faster first compile with non-bundled fonts (luaotfload rescans in WASM take 15–30 s).
