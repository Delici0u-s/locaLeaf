// Content script (isolated world): bridges the page shim and the extension.
// Page ⇄ here: window.postMessage (structured clone). Here ⇄ offscreen engine: runtime port (JSON, base64).
import { fromBase64, toWire, wireSize } from '../shared/bytes'
import { ENGINE_PORT, EXT_CHANNEL, PAGE_CHANNEL, type CompileReply, type EngineReply, type EngineRequest, type HelloReply, type PageRequest, type SyncPayload, type WireSync } from '../shared/messages'
import { getStored, mergeSettings } from '../shared/settings'
import engineConfig from '../../../config/engine.json'

let port: chrome.runtime.Port | null = null
/** Set by a stop request: the running compile (sync steps, then compile) must not send its next step. */
let stopRequested = false
let nextId = 0
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

async function enginePort(): Promise<chrome.runtime.Port> {
  if (port) return port
  const r = await chrome.runtime.sendMessage({ type: 'ensureEngine' })
  if (!r?.ok) throw new Error(`engine unavailable: ${r?.error ?? 'no response'}`)
  const p = chrome.runtime.connect({ name: ENGINE_PORT })
  p.onMessage.addListener(({ id, ok, value, error, progress }) => {
    if (progress !== undefined) {
      window.postMessage({ channel: EXT_CHANNEL, progress }, window.location.origin)
      return
    }
    const w = waiting.get(id)
    waiting.delete(id)
    if (ok) w?.resolve(value)
    else w?.reject(new Error(error))
  })
  p.onDisconnect.addListener(() => {
    port = null
    for (const w of waiting.values()) w.reject(new Error('engine disconnected'))
    waiting.clear()
  })
  port = p
  return p
}

async function engine(req: EngineRequest): Promise<EngineReply> {
  const p = await enginePort()
  const id = ++nextId
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    p.postMessage({ id, req })
  })
}

/** Splits a sync into messages below the size limit; only the first may reset. */
function chunkSync(sync: SyncPayload, maxBytes: number): WireSync[] {
  const chunks: WireSync[] = [{ reset: sync.reset, writes: [], deletes: sync.deletes }]
  let size = 0
  for (const w of sync.writes) {
    const content = toWire(w.content)
    const n = wireSize(content)
    if (size + n > maxBytes && chunks[chunks.length - 1].writes.length) {
      chunks.push({ reset: false, writes: [], deletes: [] })
      size = 0
    }
    chunks[chunks.length - 1].writes.push({ path: w.path, content })
    size += n
  }
  return chunks
}

async function settings() {
  return mergeSettings(await getStored('settings'))
}

async function handle(req: PageRequest): Promise<unknown> {
  switch (req.type) {
    case 'hello': {
      const modes = await getStored('projectModes')
      enginePort().catch(() => undefined) // start the engine early: it takes a few seconds
      return { settings: await settings(), mode: modes[req.projectId] ?? 'local', texliveYear: engineConfig.texliveYear } satisfies HelloReply
    }
    case 'compile': {
      stopRequested = false
      const s = await settings()
      for (const chunk of chunkSync(req.sync, s.maxSyncChunkBytes)) {
        const r = await engine({ type: 'sync', projectId: req.projectId, clientId: req.clientId, sync: chunk, expectEpoch: req.expectEpoch })
        if (r.kind === 'epochMismatch') return { kind: 'epochMismatch', epoch: r.epoch } satisfies CompileReply
      }
      if (stopRequested) throw new Error('compile stopped')
      const r = await engine({ type: 'compile', projectId: req.projectId, options: req.options })
      if (r.kind !== 'compiled') throw new Error(`unexpected engine reply ${r.kind}`)
      const files = Object.fromEntries(Object.entries(r.result.files).map(([k, v]) => [k, fromBase64(v)]))
      return { kind: 'done', epoch: r.epoch, result: { ...r.result, files } } satisfies CompileReply
    }
    case 'stop':
      stopRequested = true
      return engine({ type: 'stop' })
    case 'clear':
      return engine({ type: 'clear', projectId: req.projectId })
    case 'status':
      return chrome.runtime.sendMessage({ ...req, type: 'status' })
  }
}

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.channel !== PAGE_CHANNEL) return
  const { id, req } = event.data as { id: number; req: PageRequest }
  const reply = (msg: object) => window.postMessage({ channel: EXT_CHANNEL, id, ...msg }, window.location.origin)
  handle(req).then(value => reply({ ok: true, value }), err => reply({ ok: false, error: String(err?.message ?? err) }))
})
