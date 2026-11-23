// Engine worker: TeX Live 2026 in WebAssembly (texlyre-busytex), driven by our own latexmk-like loop.
// Classic worker (busytex's scripts use importScripts). One instance serves all projects; each project
// keeps its files in the in-memory FS between compiles, so recompiles only write what changed.
import type { CompileMessage, CompileResult, EngineSettings, FromWorker, SyncMessage, ToWorker } from './protocol'
import { kpseFormat, packageFiles } from './ctan'
import { applyDraft, bibtexKey, countErrors, dirname, extname, fontKey, hashBytes, joinPath, missingFiles, missingFonts, missingPackages, needsShellEscape, sameSnapshot } from './latexmk'

// Typed loosely: the project compiles with the DOM lib, not WebWorker.
declare const self: {
  BusytexPipeline: any
  importScripts(...urls: string[]): void
  postMessage(msg: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
}

const PROJECTS_ROOT = '/home/web_user/olr'
const JOB = 'output'

interface ProjectState {
  /** path → hash of every source file the page sent. */
  sources: Map<string, string>
  /** Raw main-file bytes (draft mode rewrites the copy in the FS). */
  rawSources: Map<string, Uint8Array>
  dirty: boolean
  lastKey: string | null
  lastResult: CompileResult | null
  toolKeys: { biber?: string; bibtex?: string; makeindex?: string }
  lastUsed: number
}

let pipeline: any = null
let Module: any = null
let settings: EngineSettings
let remoteEndpoint = ''
let initTime = 0
let fontIndexUrl = ''
let fontIndex: Promise<{ names: Record<string, string[]> } | null> | null = null
let ctanMirror = ''
let texliveIndexUrl = ''
let texliveIndex: Promise<Record<string, string> | null> | null = null
/** TeX Live packages already fetched from CTAN and registered with kpathsea (per worker lifetime). */
const ctanPackages = new Map<string, Promise<TarEntryLike[]>>()
type TarEntryLike = { path: string; bytes: Uint8Array }
const projects = new Map<string, ProjectState>()

const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, transfer)
const enc = new TextEncoder()
const dec = new TextDecoder()

self.onmessage = async ({ data }: MessageEvent<ToWorker>) => {
  try {
    if (data.type === 'init') {
      fontIndexUrl = data.fontIndexUrl
      texliveIndexUrl = data.texliveIndexUrl
      ctanMirror = data.ctanMirror
      await init(data.basePath, data.bundles, data.remoteEndpoint, data.settings)
    }
    else if (data.type === 'sync') sync(data)
    else if (data.type === 'compile') {
      const result = await compile(data)
      post({ type: 'compiled', id: data.id, result }, Object.values(result.files).map(f => f.buffer as ArrayBuffer))
      persistCaches().catch(e => post({ type: 'print', text: `saving caches failed: ${e}` })) // after replying
    } else if (data.type === 'debugChangedFiles' && __TEST_HOOKS__) {
      const out: string[] = []
      const walk = (dir: string) => {
        for (const name of Module.FS.readdir(dir) as string[]) {
          if (name === '.' || name === '..') continue
          const full = joinPath(dir, name)
          if (full.startsWith(PROJECTS_ROOT) || full.startsWith('/dev') || full.startsWith('/proc')) continue
          const st = Module.FS.stat(full)
          if (Module.FS.isDir(st.mode)) walk(full)
          else if (st.mtime.getTime() > initTime) out.push(`${full} ${st.size}`)
        }
      }
      walk('/')
      post({ type: 'print', text: `CHANGED ${JSON.stringify(out)}` })
      post({ type: 'cleared', projectId: '' })
    } else if (data.type === 'debugAbort' && __TEST_HOOKS__) {
      // Wipe the module's memory: every later TeX run dies with a RuntimeError, as after an out-of-memory abort.
      Module.HEAPU8.fill(0)
      post({ type: 'cleared', projectId: '' })
    } else if (data.type === 'clear') {
      clear(data.projectId)
      post({ type: 'cleared', projectId: data.projectId })
    }
  } catch (err: any) {
    post({ type: 'error', id: (data as any).id, message: String(err?.stack ?? err) })
  }
}

async function init(basePath: string, bundles: string[], remoteEndpoint: string, s: EngineSettings) {
  settings = s
  const url = (name: string) => `${basePath}/${name}`
  self.importScripts(url('busytex_biber.js'), url('busytex_pipeline.js'))
  const BusytexPipeline = self.BusytexPipeline
  const bundleJs = bundles.map(b => url(`${b}.js`))
  let versions: Record<string, string> = {}
  pipeline = new BusytexPipeline(
    url('busytex.js'), url('busytex.wasm'), bundleJs, bundleJs, [],
    (text: string) => {
      post({ type: 'print', text })
      // first start: busytex reports loading the TeX Live data ("Preparing... (3/7)")
      if (/^(Preparing|All downloads)/.test(text)) post({ type: 'progress', text: `starting the TeX engine: ${text}` })
    },
    (v: Record<string, string>) => { versions = v },
    true, BusytexPipeline.ScriptLoaderWorker,
    url('biber.js'), url('biber.wasm'), url('biber.data'),
  )
  await pipeline.on_initialized_promise
  Module = await pipeline.Module
  initTime = Date.now()
  Module.ENV.TEXLIVE_REMOTE_ENDPOINT = remoteEndpoint
  setRemote(remoteEndpoint)
  mkdirP(PROJECTS_ROOT)
  await restorePersisted().catch(e => post({ type: 'print', text: `restoring caches failed: ${e}` }))
  post({ type: 'ready', versions: Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, String(v).split('\n')[0]])) })
}

function state(projectId: string): ProjectState {
  let st = projects.get(projectId)
  if (!st) {
    st = { sources: new Map(), rawSources: new Map(), dirty: true, lastKey: null, lastResult: null, toolKeys: {}, lastUsed: 0 }
    projects.set(projectId, st)
  }
  return st
}

const projectDir = (projectId: string) => joinPath(PROJECTS_ROOT, projectId)

function sync(msg: SyncMessage) {
  const FS = Module.FS
  const root = projectDir(msg.projectId)
  if (!msg.reset && !projects.has(msg.projectId)) {
    // We don't have this project (evicted or never seen): a diff isn't enough.
    post({ type: 'synced', projectId: msg.projectId, needReset: true })
    return
  }
  const st = state(msg.projectId)
  st.lastUsed = performance.now()
  mkdirP(root)
  // A full snapshot replaces the source list. Unchanged files aren't rewritten and generated files
  // (.aux, .bbl, …) stay, so the next compile is still incremental.
  const deletes = msg.reset ? [...st.sources.keys()].filter(p => !msg.writes.some(w => w.path === p)) : msg.deletes
  for (const path of deletes) {
    const full = joinPath(root, path)
    if (FS.analyzePath(full).exists) FS.unlink(full)
    st.sources.delete(path)
    st.rawSources.delete(path)
    st.dirty = true
  }
  for (const { path, content } of msg.writes) {
    const bytes = typeof content === 'string' ? enc.encode(content) : content
    const hash = hashBytes(bytes)
    if (st.sources.get(path) === hash) continue
    const full = joinPath(root, path)
    mkdirP(dirname(full))
    FS.writeFile(full, bytes)
    st.sources.set(path, hash)
    st.rawSources.set(path, bytes)
    st.dirty = true
  }
  evictIfNeeded(msg.projectId)
  post({ type: 'synced', projectId: msg.projectId, needReset: false })
}

/** Keeps at most settings.maxProjects projects in the FS, dropping the least recently used. */
function evictIfNeeded(keep: string) {
  const others = [...projects].filter(([id]) => id !== keep).sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  while (others.length && projects.size > Math.max(1, settings.maxProjects)) {
    const [id] = others.shift()!
    Module.FS.chdir('/')
    rmTree(projectDir(id))
    projects.delete(id)
  }
}

function rmTree(dir: string) {
  const FS = Module.FS
  if (!FS.analyzePath(dir).exists) return
  for (const name of FS.readdir(dir) as string[]) {
    if (name === '.' || name === '..') continue
    const full = joinPath(dir, name)
    if (FS.isDir(FS.stat(full).mode)) rmTree(full)
    else FS.unlink(full)
  }
  FS.rmdir(dir)
}

/** Deletes everything except the sources ("Clear cached files" in Overleaf). */
function clear(projectId: string) {
  const st = projects.get(projectId)
  if (!st) return
  const root = projectDir(projectId)
  for (const path of listFiles(root)) {
    if (!st.sources.has(path)) Module.FS.unlink(joinPath(root, path))
  }
  st.toolKeys = {}
  st.lastResult = null
  st.dirty = true
}

async function compile(msg: CompileMessage): Promise<CompileResult> {
  const t0 = performance.now()
  const FS = Module.FS
  const st = state(msg.projectId)
  const root = projectDir(msg.projectId)
  const optionsKey = JSON.stringify([msg.main, msg.compiler, msg.draft, msg.stopOnFirstError])

  if (!st.sources.has(msg.main)) {
    return { status: 'failure', files: {}, passes: [], errors: 0, ms: 0, cached: false, outputDir: '', projectRoot: root, missingFonts: [], missingPackages: [], needsShellEscape: false, message: `main document ${msg.main} not found in project` }
  }
  if (!st.dirty && st.lastKey === optionsKey && st.lastResult) {
    return { ...st.lastResult, files: { ...cloneFiles(st.lastResult.files) }, cached: true, ms: performance.now() - t0 }
  }

  // Main file: draft mode is applied to the copy in the FS only.
  const mainFull = joinPath(root, msg.main)
  FS.writeFile(mainFull, applyDraft(st.rawSources.get(msg.main)!, msg.draft))

  const outDirRel = dirname(msg.main)
  const outDir = joinPath(root, outDirRel)
  const out = (ext: string) => joinPath(outDir, `${JOB}.${ext}`)
  for (const ext of ['pdf', 'xdv', 'synctex.gz', 'log']) if (FS.analyzePath(out(ext)).exists) FS.unlink(out(ext))
  FS.chdir(outDir)

  const memHeader = Uint8Array.from(Module.HEAPU8.slice(0, pipeline.mem_header_size))
  const passes: string[] = []
  const run = (cmd: string[], isBibtex = false) => {
    passes.push(cmd[0])
    post({ type: 'progress', text: cmd[0].includes('latex') ? `TeX pass ${passes.filter(p => p.includes('latex')).length}` : `running ${cmd[0]}` })
    const logs: any[] = []
    pipeline._run_cmd(Module, FS, cmd, [], 'silent', `${JOB}.log`, `${JOB}.blg`, `${JOB}.aux`, `${JOB}.bbl`, memHeader, logs)
    return logs[0]
  }

  const texCmd = buildTexCommand(msg)
  let halted = false
  let fonts: string[] = []
  const triedFonts = new Set<string>()
  const triedFiles = new Set<string>()
  let retriedCapacity = false
  for (let pass = 0; pass < settings.maxPasses; pass++) {
    const before = watchSnapshot(root)
    run(texCmd)
    let log = readText(out('log'))
    // Right after fetching fonts/packages, a LuaTeX pass occasionally dies with "TeX capacity exceeded" in this
    // WASM build (not reproducible natively). Running the pass again succeeds; a repeat is a real error.
    if (/^! TeX capacity exceeded/m.test(log) && !retriedCapacity) {
      retriedCapacity = true
      post({ type: 'print', text: 'TeX capacity exceeded: running the pass again' })
      run(texCmd)
      log = readText(out('log'))
    }
    fonts = missingFonts(log)
    const fetched = settings.fetchMissingFonts && msg.compiler !== 'pdflatex' ? await fetchFonts(fonts.filter(f => !triedFonts.has(f)), outDir) : 0
    fonts.forEach(f => triedFonts.add(f))
    if (fetched > 0) continue // the fonts are in place now: run again
    const missing = missingPackages(missingFiles(log), st.sources.keys()).filter(f => !triedFiles.has(f))
    missing.forEach(f => triedFiles.add(f))
    if (settings.fetchFromCtan && (await provideFromCtan(missing)) > 0) continue
    if (msg.stopOnFirstError && countErrors(log) > 0) {
      halted = true
      break
    }
    const ranTool = await runToolsIfNeeded(st, root, outDir, run)
    if (!ranTool && sameSnapshot(before, watchSnapshot(root))) break
  }
  if (msg.compiler === 'xelatex' && !halted && FS.analyzePath(out('xdv')).exists) {
    run(['xdvipdfmx', '-o', `${JOB}.pdf`, `${JOB}.xdv`])
  }

  const files: Record<string, Uint8Array> = {}
  for (const name of FS.readdir(outDir) as string[]) {
    if (!name.startsWith(`${JOB}.`)) continue
    const ext = name.slice(JOB.length + 1)
    if (['pdf', 'log', 'synctex.gz', ...settings.outputExtensions].includes(ext)) {
      files[name] = FS.readFile(joinPath(outDir, name))
    }
  }
  const finalLog = files[`${JOB}.log`] ? dec.decode(files[`${JOB}.log`]) : ''
  const errors = countErrors(finalLog)
  const packages = missingPackages(missingFiles(finalLog), st.sources.keys())
  const status = halted ? 'stopped-on-first-error' : files[`${JOB}.pdf`] ? 'success' : 'failure'
  const result: CompileResult = { status, files, passes, errors, ms: performance.now() - t0, cached: false, outputDir: outDirRel, projectRoot: root, missingFonts: fonts, missingPackages: packages, needsShellEscape: needsShellEscape(finalLog) }
  st.dirty = false
  st.lastKey = optionsKey
  st.lastResult = { ...result, files: cloneFiles(files) }
  return result
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`

function setRemote(endpoint: string) {
  remoteEndpoint = endpoint.replace(/\/$/, '')
}

/** Downloads every file of the families fontspec asked for into the compile dir, where luaotfload's
 *  rescan ("local entries") and XeTeX find them. Returns how many files were added. */
async function fetchFonts(names: string[], outDir: string): Promise<number> {
  if (!names.length || !remoteEndpoint) return 0
  fontIndex ??= fetch(fontIndexUrl).then(r => (r.ok ? r.json() : null), () => null)
  const index = await fontIndex
  if (!index) return 0
  const files = new Set<string>()
  for (const name of names) for (const f of index.names[fontKey(name)] ?? []) files.add(f)
  let added = 0
  await Promise.all([...files].map(async f => {
    const target = joinPath(outDir, f)
    if (Module.FS.analyzePath(target).exists) return
    const bytes = await fontBytes(f)
    if (!bytes) return
    Module.FS.writeFile(target, bytes)
    added++
  }))
  post({ type: 'progress', text: `fonts: fetched ${added} of ${files.size} files for ${names.join(', ')}` })
  return added
}

/** A font file from the package server, else from its TeX Live package on CTAN; cached across sessions. */
async function fontBytes(file: string): Promise<Uint8Array | null> {
  const format = /\.otf$/i.test(file) ? 47 : 36 // kpathsea: opentype / truetype
  const buf = await cached(`font:${remoteEndpoint}/${file}`, async () => {
    try {
      const res = await fetch(`${remoteEndpoint}/${format}/${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(settings.downloadTimeoutSeconds * 1000) })
      return res.ok ? res.arrayBuffer() : null
    } catch {
      return null
    }
  })
  if (buf) return new Uint8Array(buf)
  if (!settings.fetchFromCtan) return null
  const pkg = (await loadTexliveIndex())?.[file]
  const entry = pkg ? (await ctanPackage(pkg)).find(e => e.path.endsWith(`/${file}`)) : undefined
  return entry?.bytes ?? null
}

function loadTexliveIndex(): Promise<Record<string, string> | null> {
  texliveIndex ??= fetch(texliveIndexUrl)
    .then(r => (r.ok ? new Response(r.body!.pipeThrough(new DecompressionStream('gzip'))).json() : null))
    .then(j => j?.files ?? null, () => null)
  return texliveIndex
}

function ctanPackage(pkg: string): Promise<TarEntryLike[]> {
  let p = ctanPackages.get(pkg)
  if (!p) {
    post({ type: 'progress', text: `downloading TeX Live package "${pkg}" from CTAN` })
    p = packageFiles(ctanMirror, pkg, cached, {
      maxBytes: settings.maxCtanPackageMB * 1024 * 1024,
      timeoutMs: settings.downloadTimeoutSeconds * 1000,
      onTooLarge: bytes => post({ type: 'progress', text: `skipping TeX Live package "${pkg}": ${(bytes / 1048576).toFixed(0)} MB is over the ${settings.maxCtanPackageMB} MB limit` }),
      onProgress: (loaded, total) => post({ type: 'progress', text: `downloading TeX Live package "${pkg}" from CTAN: ${mb(loaded)}${total ? ` of ${mb(total)} (${Math.round((100 * loaded) / total)}%)` : ''}` }),
    }).then(entries => {
      for (const e of entries) {
        const name = e.path.slice(e.path.lastIndexOf('/') + 1)
        Module.kpse_remote_register(name, kpseFormat(name), e.bytes)
      }
      post({ type: 'progress', text: `TeX Live package "${pkg}": ${entries.length} files` })
      return entries
    }, () => [])
    ctanPackages.set(pkg, p)
  }
  return p
}

/** Fetches the TeX Live packages that contain these files. Returns how many packages were added. */
async function provideFromCtan(files: string[]): Promise<number> {
  if (!files.length || !ctanMirror) return 0
  const index = await loadTexliveIndex()
  if (!index) return 0
  const pkgs = new Set(files.map(f => index[f] ?? index[`${f}.tex`]).filter((p): p is string => !!p && !ctanPackages.has(p)))
  const results = await Promise.all([...pkgs].map(p => ctanPackage(p)))
  return results.filter(r => r.length > 0).length
}

// ---- caches that survive engine restarts ----
// luaotfload's converted fonts (expensive in WASM: the first LuaLaTeX compile of a new session drops from ~19 s
// to ~3 s with them) and every file the package server delivered. Saved to IndexedDB after compiles, restored
// when the engine starts. (XeTeX's fontconfig keeps its scan in memory only; nothing to keep there.)

const REMOTE_DIR = '/tmp/texlive_remote'
// luaotfload's font name database lives in the read-only bundle (it can't be written back), so only the fonts
const persistDirs = () => [joinPath(pipeline.dir_texmfvar, 'luatex-cache/generic/fonts'), REMOTE_DIR]

const PERSIST_INDEX = 'persist:index'
/** path → "size:mtime" of what IndexedDB has. */
let persisted = new Map<string, string>()

async function persistCaches() {
  if (!settings.persistCacheMB) { post({ type: 'print', text: 'persist: off' }); return }
  const FS = Module.FS
  const budget = settings.persistCacheMB * 1024 * 1024
  let total = 0
  const current: [string, string, number][] = []
  for (const dir of persistDirs()) {
    for (const rel of listFiles(dir)) {
      const path = joinPath(dir, rel)
      const st = FS.stat(path)
      current.push([path, `${st.size}:${st.mtime.getTime()}`, st.size])
    }
  }
  let changed = false
  for (const [path, stamp, size] of current) {
    if (total + size > budget) continue
    total += size
    if (persisted.get(path) === stamp) continue
    const bytes: Uint8Array = FS.readFile(path)
    await cachePut(`persist:${path}`, bytes.slice().buffer)
    persisted.set(path, stamp)
    changed = true
  }
  if (changed) await cachePut(PERSIST_INDEX, new TextEncoder().encode(JSON.stringify([...persisted])).buffer)
  post({ type: 'print', text: `persist: ${current.length} cache files, ${persisted.size} saved (${(total / 1048576).toFixed(1)} MB)` })
}

async function restorePersisted() {
  const index = await cacheGet(PERSIST_INDEX)
  if (!index) return
  persisted = new Map(JSON.parse(new TextDecoder().decode(index)))
  let restored = 0
  const failures: Record<string, number> = {}
  let firstFailure = ''
  for (const [path, stamp] of persisted) {
    const buf = await cacheGet(`persist:${path}`)
    if (!buf) { persisted.delete(path); continue }
    const bytes = new Uint8Array(buf)
    let step = 'write'
    try {
      if (path.startsWith(REMOTE_DIR + '/')) {
        // KPSE_REMOTE saves "<format>_<name>"; registering puts the file back where TeX looks for it.
        const m = path.slice(REMOTE_DIR.length + 1).match(/^(\d+)_([A-Za-z0-9._-]+)$/)
        if (!m) continue
        step = 'register'
        Module.kpse_remote_register(m[2], Number(m[1]), bytes)
      } else {
        step = 'mkdir'
        mkdirP(dirname(path))
        step = 'write'
        Module.FS.writeFile(path, bytes)
      }
      // luaotfload checks its font caches against the fonts' timestamps: restore the original ones
      step = 'utime'
      const mtime = Number(stamp.split(':')[1])
      Module.FS.utime(path, mtime, mtime)
      restored++
    } catch (e) {
      failures[step] = (failures[step] ?? 0) + 1
      if (!firstFailure) firstFailure = `${step} ${path}: ${e}`
    }
  }
  if (firstFailure) post({ type: 'print', text: `restore failures ${JSON.stringify(failures)}; first: ${firstFailure}` })
  post({ type: 'print', text: `restored ${restored} cached files` })
}

let cacheDb: Promise<IDBDatabase | null> | null = null
function openCacheDb(): Promise<IDBDatabase | null> {
  cacheDb ??= new Promise(resolve => {
    const req = indexedDB.open('olr-engine-cache', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('files')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
  return cacheDb
}

async function cacheGet(key: string): Promise<ArrayBuffer | null> {
  const db = await openCacheDb()
  return new Promise(resolve => {
    if (!db) return resolve(null)
    const req = db.transaction('files').objectStore('files').get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => resolve(null)
  })
}

async function cachePut(key: string, value: ArrayBuffer): Promise<void> {
  const db = await openCacheDb()
  if (!db) return
  return new Promise(resolve => {
    const tx = db.transaction('files', 'readwrite')
    tx.objectStore('files').put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

/** IndexedDB-backed cache in the extension origin (fonts, CTAN archives). */
async function cached(key: string, load: () => Promise<ArrayBuffer | null>): Promise<ArrayBuffer | null> {
  const hit = await cacheGet(key)
  if (hit) return hit
  const value = await load()
  if (value) await cachePut(key, value)
  return value
}

function buildTexCommand(msg: CompileMessage): string[] {
  const fmt = pipeline.fmt
  const common = ['-synctex=1', '--no-shell-escape', '--interaction=batchmode', `-jobname=${JOB}`]
  if (msg.stopOnFirstError) common.push('--halt-on-error')
  const main = msg.main.slice(msg.main.lastIndexOf('/') + 1)
  switch (msg.compiler) {
    case 'pdflatex': return ['pdflatex', ...common, '--output-format=pdf', '--fmt', fmt.pdftex, main]
    case 'xelatex': return ['xelatex', ...common, '--no-pdf', '--fmt', fmt.xetex, main]
    case 'lualatex': return ['luahblatex', ...common, '--output-format=pdf', '--fmt', fmt.luahbtex, '--nosocket', main]
  }
}

/** Runs biber / bibtex / makeindex when their inputs changed since they last ran. Returns whether any ran. */
async function runToolsIfNeeded(st: ProjectState, root: string, outDir: string, run: (cmd: string[]) => unknown): Promise<boolean> {
  const FS = Module.FS
  const exists = (p: string) => FS.analyzePath(joinPath(outDir, p)).exists
  const bibHashes = [...st.sources].filter(([p]) => extname(p) === 'bib' || extname(p) === 'bst').map(([p, h]) => `${p}:${h}`).join(',')
  let ran = false

  if (exists(`${JOB}.bcf`)) {
    const key = hashBytes(FS.readFile(joinPath(outDir, `${JOB}.bcf`))) + bibHashes
    if (key !== st.toolKeys.biber || !exists(`${JOB}.bbl`)) {
      await runBiber(st, root, outDir)
      st.toolKeys.biber = key
      ran = true
    }
  } else {
    const auxTexts = listFiles(outDir).filter(p => extname(p) === 'aux').map(p => readText(joinPath(outDir, p)))
    const bk = bibtexKey(auxTexts)
    if (bk !== null) {
      const key = bk + bibHashes
      if (key !== st.toolKeys.bibtex || !exists(`${JOB}.bbl`)) {
        run(['bibtex8', '--8bit', `${JOB}.aux`])
        st.toolKeys.bibtex = key
        ran = true
      }
    }
  }
  if (exists(`${JOB}.idx`)) {
    const key = hashBytes(FS.readFile(joinPath(outDir, `${JOB}.idx`)))
    if (key !== st.toolKeys.makeindex) {
      run(['makeindex', `${JOB}.idx`])
      st.toolKeys.makeindex = key
      ran = true
    }
  }
  return ran
}

/** biber runs in its own WASM module. Unlike busytex's wrapper we keep the project's folder layout,
 *  so \addbibresource{refs/x.bib} resolves, and pass settings.biberArgs. */
async function runBiber(st: ProjectState, root: string, outDir: string) {
  const biber = pipeline.biber
  if (!biber) throw new Error('biber is not available in this engine build')
  const B = await biber.instantiate()
  const work = biber.work_dir as string
  const mk = (dir: string) => { let cur = ''; for (const part of dir.split('/').filter(Boolean)) { cur += '/' + part; if (!B.FS.analyzePath(cur).exists) B.FS.mkdir(cur) } }
  mk(work)
  // Paths relative to the output dir, as biber sees them from the .bcf.
  const rel = (p: string) => outDirRelative(joinPath(root, p), outDir)
  for (const [path] of st.sources) {
    if (extname(path) !== 'bib') continue
    const target = joinPath(work, rel(path))
    if (target.includes('..')) continue
    mk(dirname(target))
    B.FS.writeFile(target, Module.FS.readFile(joinPath(root, path)))
  }
  B.FS.writeFile(joinPath(work, `${JOB}.bcf`), Module.FS.readFile(joinPath(outDir, `${JOB}.bcf`)))
  B.FS.chdir(work)
  biber.last_output = ''
  let code = 0
  try {
    code = B.callMain([biber.bin_biber, '--output-format=bbl', `--outfile=${JOB}.bbl`, ...settings.biberArgs, `${JOB}.bcf`])
  } catch (e: any) {
    code = typeof e?.status === 'number' ? e.status : 1
  }
  const bbl = joinPath(work, `${JOB}.bbl`)
  if (B.FS.analyzePath(bbl).exists) Module.FS.writeFile(joinPath(outDir, `${JOB}.bbl`), B.FS.readFile(bbl))
  const blgPath = joinPath(work, `${JOB}.blg`)
  const blg = B.FS.analyzePath(blgPath).exists ? B.FS.readFile(blgPath) : enc.encode(biber.last_output)
  Module.FS.writeFile(joinPath(outDir, `${JOB}.blg`), blg)
  if (code !== 0) post({ type: 'print', text: `biber exited with ${code}` })
}

function outDirRelative(full: string, outDir: string): string {
  return full.startsWith(outDir + '/') ? full.slice(outDir.length + 1) : full.slice(1)
}

/** Hashes of the files whose change means "run TeX again" (aux, toc, bbl, …), anywhere in the project. */
function watchSnapshot(root: string): Map<string, string> {
  const snap = new Map<string, string>()
  for (const path of listFiles(root)) {
    if (settings.rerunExtensions.includes(extname(path))) snap.set(path, hashBytes(Module.FS.readFile(joinPath(root, path))))
  }
  return snap
}

function listFiles(dir: string, prefix = ''): string[] {
  const FS = Module.FS
  if (!FS.analyzePath(dir).exists) return []
  const out: string[] = []
  for (const name of FS.readdir(dir) as string[]) {
    if (name === '.' || name === '..') continue
    const full = joinPath(dir, name)
    if (FS.isDir(FS.stat(full).mode)) out.push(...listFiles(full, joinPath(prefix, name)))
    else out.push(joinPath(prefix, name))
  }
  return out
}

function mkdirP(dir: string) {
  let cur = ''
  for (const part of dir.split('/').filter(Boolean)) {
    cur += '/' + part
    if (!Module.FS.analyzePath(cur).exists) Module.FS.mkdir(cur)
  }
}

function readText(path: string): string {
  return Module.FS.analyzePath(path).exists ? dec.decode(Module.FS.readFile(path)) : ''
}

function cloneFiles(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.slice()]))
}
