// Offscreen document: hosts the TeX engine worker for all Overleaf tabs and serializes requests to it.
// Each worker (re)start is a new "epoch"; pages must send a full snapshot after the epoch changes.
import { fromWire, toBase64 } from '../shared/bytes'
import { ENGINE_PORT, type EngineReply, type EngineRequest, type WireCompileResult } from '../shared/messages'
import type { FromWorker, ToWorker } from '../engine/protocol'

interface EngineConfig {
  idleMinutes: number
  ctanMirror: string
  basePath: string
  bundles: string[]
  remoteEndpoint: string
  engine: import('../engine/protocol').EngineSettings
}

let config: EngineConfig
let worker: Worker | null = null
let epoch = 0
let ready: Promise<void> = Promise.resolve()
let pending: { resolve: (m: FromWorker) => void; reject: (e: Error) => void } | null = null
let queue: Promise<unknown> = Promise.resolve()
let compileId = 0
/** Errors after which the WASM module is unusable. */
const FATAL = /abort|RuntimeError|out of memory|memory access out of bounds|unreachable|crashed/i
/** Where progress of the request being handled goes (its tab). */
let notify: ((text: string) => void) | null = null
/** Bumped by stop(): compiles queued before the stop are dropped instead of run on the new worker. */
let generation = 0
/** Which page last synced each project: diffs from another page (second tab) need a full snapshot first. */
const lastClient = new Map<string, string>()

function startWorker() {
  worker?.terminate()
  epoch++
  lastClient.clear()
  const w = new Worker(chrome.runtime.getURL('engine-worker.js'))
  worker = w
  w.onmessage = ({ data }: MessageEvent<FromWorker>) => {
    if (data.type === 'print') return
    if (data.type === 'progress') { notify?.(data.text); return }
    const p = pending
    pending = null
    if (data.type === 'error') p?.reject(new Error(data.message))
    else p?.resolve(data)
  }
  w.onerror = e => {
    const p = pending
    pending = null
    p?.reject(new Error(`engine worker crashed: ${e.message}`))
  }
  ready = call({ type: 'init', basePath: config.basePath, bundles: config.bundles, remoteEndpoint: config.remoteEndpoint, fontIndexUrl: chrome.runtime.getURL('font-index.json'), texliveIndexUrl: chrome.runtime.getURL('texlive-files.json.gz'), ctanMirror: config.ctanMirror, settings: config.engine }).then(() => undefined)
}

function call(msg: ToWorker, transfer: Transferable[] = []): Promise<FromWorker> {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject }
    worker!.postMessage(msg, transfer)
  })
}

async function handle(req: EngineRequest, gen: number): Promise<EngineReply> {
  try {
    await ready
  } catch {
    startWorker() // a failed init gets one fresh attempt per request
    await ready
  }
  if (req.type === 'compile' && gen !== generation) throw new Error('compile stopped')
  switch (req.type) {
    case 'sync': {
      if (!req.sync.reset && ((req.expectEpoch !== null && req.expectEpoch !== epoch) || lastClient.get(req.projectId) !== req.clientId)) {
        return { kind: 'epochMismatch', epoch }
      }
      lastClient.set(req.projectId, req.clientId)
      const writes = req.sync.writes.map(w => ({ path: w.path, content: fromWire(w.content) }))
      const transfer = writes.flatMap(w => (typeof w.content === 'string' ? [] : [w.content.buffer as ArrayBuffer]))
      const r = await call({ type: 'sync', projectId: req.projectId, writes, deletes: req.sync.deletes, reset: req.sync.reset }, transfer)
      if (r.type === 'synced' && r.needReset) {
        lastClient.delete(req.projectId)
        return { kind: 'epochMismatch', epoch }
      }
      return { kind: 'synced', epoch }
    }
    case 'debugAbort':
      if (__TEST_HOOKS__) await call({ type: 'debugAbort' })
      return { kind: 'ok' }
    case 'compile': {
      let reply
      try {
        reply = await call({ type: 'compile', id: ++compileId, projectId: req.projectId, ...req.options })
      } catch (e: any) {
        // An aborted WASM module (out of memory, …) fails every later call: start a fresh engine.
        if (FATAL.test(String(e?.message ?? e))) {
          startWorker()
          throw new Error(`engine crashed and was restarted: ${String(e?.message ?? e).split('\n')[0]}`)
        }
        throw e
      }
      if (reply.type !== 'compiled') throw new Error(`unexpected engine reply ${reply.type}`)
      const r = reply.result
      const result: WireCompileResult = { ...r, files: Object.fromEntries(Object.entries(r.files).map(([k, v]) => [k, toBase64(v)])) }
      return { kind: 'compiled', epoch, result }
    }
    case 'clear':
      await call({ type: 'clear', projectId: req.projectId })
      return { kind: 'ok' }
    case 'stop':
      return { kind: 'ok' }
  }
}

/** Stopping can't wait in the queue (a compile is blocking it): restart the worker right away. */
function stop() {
  generation++
  const p = pending
  pending = null
  p?.reject(new Error('compile stopped'))
  startWorker()
}

// Idle shutdown: with no Overleaf tab connected for a while, ask the background to close this document.
let connected = 0
let idleTimer: number | undefined
function trackIdle(delta: number) {
  connected += delta
  clearTimeout(idleTimer)
  if (connected === 0 && config?.idleMinutes > 0) {
    idleTimer = window.setTimeout(() => chrome.runtime.sendMessage({ type: 'closeEngine' }), config.idleMinutes * 60_000)
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== ENGINE_PORT) return
  trackIdle(1)
  port.onDisconnect.addListener(() => trackIdle(-1))
  port.onMessage.addListener(({ id, req }: { id: number; req: EngineRequest }) => {
    const reply = (msg: object) => { try { port.postMessage({ id, ...msg }) } catch { /* tab went away */ } }
    if (req.type === 'stop') {
      stop()
      reply({ ok: true, value: { kind: 'ok' } })
      return
    }
    const gen = generation
    const run = queue.then(() => {
      notify = text => { try { port.postMessage({ id, progress: text }) } catch { /* tab went away */ } }
      return handle(req, gen)
    })
    queue = run.catch(() => undefined)
    run.then(value => reply({ ok: true, value }), err => reply({ ok: false, error: String(err?.message ?? err) }))
  })
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'restartEngine') {
    // from the popup: fresh worker (pages resync on their next compile, as after a stop)
    stop()
    sendResponse({ ok: true })
    return false
  }
  if (msg?.type === 'engineStatus') {
    // answers at once (also while the engine is still starting), so callers never wait on it
    let state = 'starting'
    ready.then(() => { state = 'ready' }, () => { state = 'error' })
    queueMicrotask(() => sendResponse({ state, epoch }))
    return true
  }
})

;(async () => {
  config = await chrome.runtime.sendMessage({ type: 'getEngineConfig' })
  startWorker()
  await chrome.runtime.sendMessage({ type: 'offscreenReady' })
})()
