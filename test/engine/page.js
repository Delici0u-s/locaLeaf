// Drives the engine worker for test/engine/run.mjs (window.engine.*).
let worker
let pending = null // one request at a time, like the offscreen document
const prints = []

function request(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject }
    worker.postMessage(msg, transfer)
  })
}

window.engine = {
  async init(opts) {
    worker = new Worker('/build/engine-worker.js')
    worker.onmessage = ({ data }) => {
      if (data.type === 'print') { prints.push(data.text); return }
      const p = pending
      pending = null
      if (data.type === 'error') p?.reject(new Error(data.message))
      else p?.resolve(data)
    }
    const t0 = performance.now()
    const r = await request({ type: 'init', ...opts })
    return { ms: performance.now() - t0, versions: r.versions }
  },
  // files: [{path, url}] fetched here so the bytes never pass through Playwright.
  async sync(projectId, files, { reset = false, overrides = {}, deletes = [] } = {}) {
    const writes = []
    for (const f of files) {
      if (f.path in overrides) writes.push({ path: f.path, content: overrides[f.path] })
      else writes.push({ path: f.path, content: new Uint8Array(await (await fetch(f.url)).arrayBuffer()) })
    }
    const t0 = performance.now()
    await request({ type: 'sync', projectId, writes, deletes, reset })
    return { ms: performance.now() - t0 }
  },
  async compile(projectId, opts) {
    const r = await request({ type: 'compile', id: Math.random(), projectId, ...opts })
    const res = r.result
    window.lastFiles = res.files // raw outputs, for debugging from Playwright
    const log = res.files['output.log'] ? new TextDecoder().decode(res.files['output.log']) : ''
    return {
      status: res.status, errors: res.errors, missingFonts: res.missingFonts, passes: res.passes, ms: res.ms, cached: res.cached,
      pdfBytes: res.files['output.pdf']?.byteLength ?? 0, synctexBytes: res.files['output.synctex.gz']?.byteLength ?? 0,
      files: Object.keys(res.files), log, message: res.message,
    }
  },
  prints: () => prints.splice(0),
}
window.engineReady = true
