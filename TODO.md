# LocaLeaf TODO

## Requested (2026-11-23)

- [x] **Popup UI redesign.** Cards for site (switch), project (Local | Server), statistics (tiles) and grouped,
  labelled settings (`config/settings.ui.json`; unknown settings land in Advanced); light and dark.
  Was: **Popup UI redesign.** The current popup is a plain form. Needs a proper switch for local/server
  compiling, a clear status area, and settings grouped and explained instead of a raw key list.
  - [x] **Progress chip position:** a setting for where the chip goes: a screen corner, dragged into place in the
    page, or inline in Overleaf's PDF toolbar (in the empty space right of the download button, which sits
    right of Recompile). Inline needs a robust way to find that toolbar.
- [x] **Progress / first-load indicator in the page.** A status chip (after `statusDelayMs`) shows what LocaLeaf
  is doing: loading the project (docs/files done), starting the engine, TeX pass n, downloads with MB and %,
  plus the elapsed seconds. The same lines go to the console.
- [x] **Compile statistics.** Local vs. server counts, average and last time, per project and overall, in the
  popup (stored by the background). Shown plainly for now; part of the popup redesign.
- [x] **A real project compiles on the server but hangs locally** (the mirror loads, then no compile result).
  The progress output now shows where it is; a time limit falls back to the server. Waiting for the console
  output from that project to find the cause. Works now; a likely cause was found and fixed on the way:
  `joinTimeoutMs` was defined but never used, so an unanswered joinDoc waited forever.

## Robustness

- [x] Time limit for local compiles, then fall back to the server (`localTimeoutSeconds`, default 240).
- [x] Size limit for CTAN package downloads (`engine.maxCtanPackageMB`, default 60) and a download timeout.
- [x] Engine crash / out-of-memory: an aborted WASM module (out of memory, RuntimeError, …) used to break every
  later compile. The offscreen document now restarts the engine and the page retries once locally (e2e test
  simulates it with a test-build-only hook).
- [x] `minted` / shell-escape: detected (errors + shell-escape messages) and compiled on the server
  (`serverOnShellEscape`); engine test case.
- [ ] Root cause of the intermittent "TeX capacity exceeded" after fetching fonts (worked around by a retry;
  not reproducible natively, so likely inside the WASM build's memory restore between runs).

- [x] Intermittent rename failure in the extremes test: the logged mirror paths showed the file really was
  renamed to "umbenannt.tex.tex": a test timing bug (Ctrl+A before the rename box had focus), not LocaLeaf.
  The test now fills the box. (Tree changes are applied from Overleaf's requests and in-flight ones are awaited,
  which stays as a safeguard.)

- [x] Hang until the time limit when a new/reloaded tab needed the engine after Chrome had stopped the idle
  service worker (it waited for a "ready" message sent long ago). Fixed; e2e test stops the service worker.
  Also: timeouts on every real-time call, reconnect before the barrier, progress for each compile phase.

## Nice to have

- [x] Per-project build state across restarts (`engine.persistBuildMB`): first compile after reopening is
  incremental (book: 30 s / 5 passes → 13 s / 2 passes), instant when nothing changed.
- [x] Restart-engine button in the popup.
- [x] Warm-up race (`raceWhileCold`): until a tab's first local compile finishes, a compile not done within
  `raceHeadStartMs` also goes to the server and the first PDF wins; the local build finishes in the background,
  then compiles are local only. The losing server compile is stopped. e2e: `test/e2e/race.mjs`.
- [x] Packaged release: `npm run package` → `release/localeaf-<version>.zip` (no personal sites in it).
- [x] Faster first compile with non-bundled fonts: converted LuaTeX font caches and package-server files are
  kept in IndexedDB across engine restarts (`engine.persistCacheMB`). LuaLaTeX with Fira Sans: first compile of a
  new session 19 s → 3 s. XeLaTeX stays ~30 s on the first compile per session: its fontconfig scan lives only in
  memory in this build (no cache files to keep; tried a writable cachedir, it isn't used).
