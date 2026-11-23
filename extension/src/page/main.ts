// Page script (MAIN world, document_start): answers Overleaf's compile requests with local builds.
// Overleaf's own UI then shows the PDF, log, error markers and SyncTeX as if the server had compiled.
import type { CompileOptions, CompileResult, Compiler } from '../engine/protocol'
import type { CompileReply, HelloReply } from '../shared/messages'
import type { Settings } from '../shared/settings'
import { ext, getMeta, whenDomReady } from './bridge'
import { ProjectMirror } from './mirror'
import { OUTPUT_PREFIX, OutputStore, compileResponse } from './outputs'
import { installSocketHook, onEditorSocket, whenIo } from './socket-hook'
import { syncFromCode, syncFromPdf } from './synctex'
import { showToast } from './toast'

const SUPPORTED: Compiler[] = ['pdflatex', 'xelatex', 'lualatex']
const log = (...a: unknown[]) => console.info('[overleaf-local-render]', ...a)

installSocketHook()

const originalFetch = window.fetch.bind(window)
const editorVersions = new Map<string, number>()
let settings: Settings | null = null
let mode: 'local' | 'server' = 'local'
let projectId = ''
let mirror: ProjectMirror | null = null
let knownEpoch: number | null = null
let compiling: { stopped: boolean } | null = null
/** Set when this project needs something only the server has (e.g. fonts); later compiles go there directly. */
let serverOnly: string | null = null
const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const store = new OutputStore(() => settings?.keepBuilds ?? 1)
const helloDone = start()
let lastCompile: { status: string; passes: string[]; errors: number; main: string; log: string; ms: number } | null = null

// Debug hook (also handy in the browser console): what the last local compile did.
;(window as any).__overleafLocalRender = {
  lastCompile: () => lastCompile,
  mirrorPaths: () => (mirror ? [...mirror.entities.keys()].map(id => mirror!.pathOf(id)).filter(Boolean).sort() : []),
}

onEditorSocket(socket => {
  // The editor's acks tell us which version of each doc the server has; the mirror must reach it
  // before we compile (the compile barrier).
  socket.on('otUpdateApplied', (u: { doc?: string; v?: number }) => {
    if (u?.doc && typeof u.v === 'number') editorVersions.set(u.doc, Math.max(editorVersions.get(u.doc) ?? 0, u.v + 1))
  })
})

async function start() {
  await whenDomReady()
  projectId = getMeta('ol-project_id') ?? location.pathname.split('/')[2]
  const hello = await ext<HelloReply>({ type: 'hello', projectId })
  settings = hello.settings
  mode = hello.mode
  log(`mode: ${mode}`)
  if (mode !== 'local') return
  await whenIo()
  mirror = new ProjectMirror(projectId, getMeta('ol-wsUrl') ?? '', settings, log)
  mirror.ready.catch(e => log('mirror failed to start', e))
}

window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (url.origin !== location.origin) return originalFetch(input, init)

  if (url.pathname.startsWith(OUTPUT_PREFIX)) return store.respond(url.pathname, header(input, init, 'Range'))

  const m = url.pathname.match(/^\/project\/([^/]+)\/(compile|compile\/stop|output|sync\/code|sync\/pdf)$/)
  if (!m) return originalFetch(input, init)
  await helloDone.catch(() => undefined)
  if (mode !== 'local' || !mirror || m[1] !== projectId) return originalFetch(input, init)

  const action = m[2]
  if (action === 'compile' && method === 'POST') {
    if (serverOnly) return originalFetch(input, init)
    return handleCompile(input, init)
  }
  if (action === 'compile/stop' && method === 'POST' && compiling) {
    compiling.stopped = true
    await ext({ type: 'stop' }).catch(() => undefined)
    knownEpoch = null
    return json({})
  }
  if (action === 'output' && method === 'DELETE') {
    await ext({ type: 'clear', projectId }).catch(() => undefined)
    return new Response(null, { status: 204 })
  }
  if ((action === 'sync/code' || action === 'sync/pdf') && url.searchParams.get('clsiserverid') === 'olr-local') {
    const build = store.latest(projectId)
    if (!build) return json(action === 'sync/code' ? { pdf: [] } : { code: [] })
    return json(action === 'sync/code' ? await syncFromCode(build, url.searchParams) : await syncFromPdf(build, url.searchParams))
  }
  return originalFetch(input, init)
}

async function handleCompile(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const t0 = performance.now()
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
  const state = { stopped: false }
  compiling = state
  try {
    // A mirror that failed to start (server hiccup) gets one fresh attempt per compile.
    await mirror!.ready.catch(() => restartMirror())
    const compiler = mirror!.project.compiler as Compiler
    if (!SUPPORTED.includes(compiler)) throw new Fallback(`compiler "${compiler}" isn't supported locally`)
    const main = body.rootResourcePath || (body.rootDoc_id && mirror!.pathOf(body.rootDoc_id))
    if (!main) throw new Fallback('no main document')
    await barrier()
    const options: CompileOptions = { main, compiler, draft: !!body.draft, stopOnFirstError: !!body.stopOnFirstError }
    const result = await compileWithEngine(options)
    if (result.missingFonts.length && settings?.serverOnMissingFonts) {
      serverOnly = `fonts not available locally: ${result.missingFonts.join(', ')}`
      throw new Fallback(serverOnly)
    }
    const build = store.add(projectId, result)
    lastCompile = { status: result.status, passes: result.passes, errors: result.errors, main, ms: result.ms, log: new TextDecoder().decode(result.files['output.log'] ?? new Uint8Array()) }
    log(`compiled ${main} locally: ${result.status}, ${result.passes.length} passes, engine ${Math.round(result.ms)} ms, total ${Math.round(performance.now() - t0)} ms${result.cached ? ' (unchanged)' : ''}`)
    ext({ type: 'status', state: 'local', detail: `last compile ${result.status} in ${(result.ms / 1000).toFixed(1)} s` }).catch(() => undefined)
    return json(compileResponse(store, build, result))
  } catch (e: any) {
    knownEpoch = null
    if (state.stopped) return json({ status: 'terminated', outputFiles: [], pdfCachingMinChunkSize: 0, validationProblems: null })
    log('local compile failed:', e)
    if (settings?.fallbackToServer === false && !(e instanceof Fallback)) throw e
    ext({ type: 'status', state: 'fallback', detail: String(e?.message ?? e) }).catch(() => undefined)
    showToast(`Compiled on the server: ${e?.message ?? e}`, settings?.toastMs)
    return originalFetch(input, init)
  } finally {
    compiling = null
  }
}

class Fallback extends Error {}

async function compileWithEngine(options: CompileOptions): Promise<CompileResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (mirror!.broken) await restartMirror()
    const { sync, commit } = mirror!.takeSync(knownEpoch === null)
    const reply = await ext<CompileReply>({ type: 'compile', projectId, clientId, sync, options, expectEpoch: knownEpoch })
    if (reply.kind === 'epochMismatch') {
      knownEpoch = null
      continue
    }
    commit()
    knownEpoch = reply.epoch
    return reply.result
  }
  throw new Error('the engine restarted during the compile')
}

async function restartMirror() {
  log('mirror lost track of the project, reconnecting')
  mirror!.close()
  mirror = new ProjectMirror(projectId, getMeta('ol-wsUrl') ?? '', settings!, log)
  knownEpoch = null
  await mirror.ready
}

/** Waits until the mirror has every doc version the editor knows the server has. */
async function barrier() {
  const deadline = performance.now() + (settings?.barrierTimeoutMs ?? 0)
  for (const [doc, v] of editorVersions) {
    while (mirror!.hasDoc(doc) && (mirror!.docVersion(doc) ?? v) < v) {
      if (performance.now() > deadline) {
        log(`mirror behind on ${doc}, fetching it again`)
        await mirror!.refreshDoc(doc)
        break
      }
      await new Promise(r => setTimeout(r, 5))
    }
  }
}

function header(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers ?? (input instanceof Request ? input.headers : undefined)
  if (!h) return null
  if (h instanceof Headers) return h.get(name)
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null
  const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase())
  return key ? (h as Record<string, string>)[key] : null
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// Links to output files ("Other logs and files") are navigations, which fetch() doesn't see.
document.addEventListener('click', event => {
  const a = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!a) return
  const u = new URL(a.href, location.href)
  if (u.origin !== location.origin || !u.pathname.startsWith(OUTPUT_PREFIX)) return
  const hit = store.lookup(u.pathname)
  if (!hit) return
  event.preventDefault()
  const link = document.createElement('a')
  link.href = store.blobUrl(hit.build, hit.name)
  link.download = hit.name
  link.click()
}, true)
