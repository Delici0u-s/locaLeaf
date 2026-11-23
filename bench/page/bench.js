// Runs inside the browser page. Driven by scripts/run-wasm.mjs through window.bench.
import { BusyTexRunner } from '/node_modules/texlyre-busytex/dist/index.js'

const DRIVERS = {
  pdflatex: 'pdftex_bibtex8',
  xelatex: 'xetex_bibtex8_dvipdfmx',
  lualatex: 'luahbtex_bibtex8',
}

let runner = null
const fileCache = new Map()

async function loadFile(fixture, path) {
  const key = `${fixture}/${path}`
  if (!fileCache.has(key)) {
    const res = await fetch(`/fixtures/${fixture}/${path.split('/').map(encodeURIComponent).join('/')}`)
    if (!res.ok) throw new Error(`fetch ${key}: ${res.status}`)
    fileCache.set(key, new Uint8Array(await res.arrayBuffer()))
  }
  return fileCache.get(key)
}

window.bench = {
  async init({ basePath, preload }) {
    const t0 = performance.now()
    runner = new BusyTexRunner({
      busytexBasePath: basePath,
      preloadDataPackages: preload.map(p => `${basePath}/${p}`),
    })
    await runner.initialize(true)
    return { ms: performance.now() - t0 }
  },

  // One compile of a whole project. overrides maps path → text that replaces that file (for the edit rounds).
  async compile({ fixture, paths, main, overrides, compiler, tools, rerun, remoteEndpoint }) {
    const driver = DRIVERS[compiler]
    if (!driver) return { ok: false, error: `no WASM driver for compiler ${compiler}` }
    const files = []
    for (const path of paths) {
      files.push({ path, content: path in overrides ? overrides[path] : await loadFile(fixture, path) })
    }
    const t0 = performance.now()
    try {
      const r = await runner.compile(
        files, main, tools.bibtex ?? null, tools.biber ?? null, tools.makeindex ?? null,
        rerun, 'silent', driver, null, remoteEndpoint || undefined
      )
      return {
        ok: true,
        ms: performance.now() - t0,
        success: r.success,
        exitCode: r.exitCode,
        pdfBytes: r.pdf?.byteLength ?? 0,
        synctexBytes: r.synctex?.byteLength ?? 0,
        passes: r.logs?.map(l => l.cmd) ?? [],
        logTail: (r.log ?? '').slice(-3000),
      }
    } catch (e) {
      return { ok: false, ms: performance.now() - t0, error: String(e?.stack ?? e) }
    }
  },
}

// Prototype of the extension's own rerun logic ("mini latexmk"): keep the files the engine generated
// (.aux, .toc, .bbl, …) between compiles, run one pass, and only rerun while those files still change.
const kept = new Map() // fixture → Map(path → bytes) of generated files
const sameBytes = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i])
const toBytes = c => (typeof c === 'string' ? new TextEncoder().encode(c) : c)

async function readGenerated(sources, skip) {
  const out = new Map()
  for (const f of await runner.readProjectFiles()) {
    const rel = f.path.replace(/^\/home\/web_user\/project_dir\//, '')
    if (sources.has(rel) || skip.some(re => new RegExp(re).test(rel))) continue
    out.set(rel, toBytes(f.content))
  }
  return out
}

window.bench.compileIncremental = async ({ fixture, paths, main, overrides, compiler, tools, rerun, remoteEndpoint, maxPasses, skipGenerated, rerunOn }) => {
  const driver = DRIVERS[compiler]
  const sources = new Set(paths)
  const files = []
  for (const path of paths) files.push({ path, content: path in overrides ? overrides[path] : await loadFile(fixture, path) })
  const t0 = performance.now()
  const passes = []
  try {
    let generated = kept.get(fixture)
    let r
    if (!generated) {
      // No state yet: one full pipeline compile (tools + reruns), then keep what it generated.
      r = await runner.compile(files, main, tools.bibtex ?? null, tools.biber ?? null, tools.makeindex ?? null, rerun, 'silent', driver, null, remoteEndpoint || undefined)
      passes.push('full')
      generated = await readGenerated(sources, skipGenerated)
    } else {
      for (let pass = 0; pass < maxPasses; pass++) {
        const input = [...files, ...[...generated].map(([path, content]) => ({ path, content }))]
        r = await runner.compile(input, main, false, false, false, false, 'silent', driver, null, remoteEndpoint || undefined)
        passes.push('single')
        const next = await readGenerated(sources, skipGenerated)
        const changed = [...next].filter(([p, c]) => rerunOn.some(re => new RegExp(re).test(p)) && !sameBytes(c, generated.get(p)))
        generated = new Map([...generated, ...next])
        if (!r.success || changed.length === 0) break
      }
    }
    kept.set(fixture, generated)
    return { ok: true, ms: performance.now() - t0, success: r.success, exitCode: r.exitCode, pdfBytes: r.pdf?.byteLength ?? 0, passes, keptFiles: generated.size, logTail: (r.log ?? '').slice(-3000) }
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, error: String(e?.stack ?? e), passes }
  }
}

window.benchReady = true
