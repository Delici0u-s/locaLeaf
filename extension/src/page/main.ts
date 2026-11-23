// Page script (MAIN world, document_start): answers Overleaf's compile requests with local builds.
// Overleaf's own UI then shows the PDF, log, error markers and SyncTeX as if the server had compiled.
import type { CompileOptions, CompileResult, Compiler } from '../engine/protocol'
import type { CompileReply, HelloReply } from '../shared/messages'
import type { Settings } from '../shared/settings'
import { ext, getMeta, onProgress, whenDomReady } from './bridge'
import { beginStatus, configureStatus, finishStatus, updateStatus } from './status'
import { ProjectMirror } from './mirror'
import { OUTPUT_PREFIX, OutputStore, compileResponse } from './outputs'
import { installSocketHook, onEditorSocket, whenIo } from './socket-hook'
import { syncFromCode, syncFromPdf } from './synctex'
import { showToast } from './toast'

const SUPPORTED: Compiler[] = ['pdflatex', 'xelatex', 'lualatex']
const log = (...a: unknown[]) => console.info('[localeaf]', ...a)

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

// Engine progress → indicator, and to the console (download percentages only every quarter).
onProgress(text => {
  updateStatus(text)
  const pct = text.match(/\((\d+)%\)$/)
  if (!pct || Number(pct[1]) % 25 === 0) log(text)
})
const mirrorProgress = (text: string) => updateStatus(text)
let lastCompile: { status: string; passes: string[]; errors: number; main: string; log: string; ms: number } | null = null

// Debug hook (also handy in the browser console): what the last local compile did.
;(window as any).__localeaf = {
  lastCompile: () => lastCompile,
  docTypes: () => mirror?.docTypes() ?? {},
  ...(__TEST_HOOKS__ ? { debugAbortEngine: () => ext({ type: 'debugAbort' }) } : {}),
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
  configureStatus(settings, (x, y) => ext({ type: 'updateSettings', patch: { statusPosition: 'custom', statusX: x, statusY: y } }).catch(() => undefined))
  log(`mode: ${mode}`)
  if (mode !== 'local') return
  await whenIo()
  mirror = new ProjectMirror(projectId, getMeta('ol-wsUrl') ?? '', settings, log, mirrorProgress)
  mirror.ready.then(() => noticeTexLiveYear(hello.texliveYear), e => log('mirror failed to start', e))
}

window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (url.origin !== location.origin) return originalFetch(input, init)

  if (url.pathname.startsWith(OUTPUT_PREFIX)) return store.respond(url.pathname, header(input, init, 'Range'))

  const tree = treeChange(url, method)
  if (tree) return trackTreeChange(tree, input, init)

  const m = url.pathname.match(/^\/project\/([^/]+)\/(compile|compile\/stop|output|sync\/code|sync\/pdf)$/)
  if (!m) return originalFetch(input, init)
  await helloDone.catch(() => undefined)
  if (mode !== 'local' || !mirror || m[1] !== projectId) return originalFetch(input, init)

  const action = m[2]
  if (action === 'compile' && method === 'POST') {
    if (serverOnly) {
      const t = performance.now()
      const res = await originalFetch(input, init)
      ext({ type: 'status', state: 'fallback', detail: serverOnly, projectId, ms: performance.now() - t }).catch(() => undefined)
      return res
    }
    return handleCompile(input, init)
  }
  if (action === 'compile/stop' && method === 'POST' && compiling) {
    log('stop requested')
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
  const state = { stopped: false, abandoned: false }
  compiling = state
  beginStatus('compiling locally', settings?.statusDelayMs ?? 0)
  // A local compile that runs past the limit is stopped and compiled on the server instead.
  const limitS = settings?.localTimeoutSeconds ?? 0
  let timer: number | undefined
  const tooLong = new Promise<never>((_, reject) => {
    if (limitS > 0) timer = window.setTimeout(() => {
      state.abandoned = true
      ext({ type: 'stop' }).catch(() => undefined)
      knownEpoch = null
      reject(new Fallback(`the local compile took longer than ${limitS} s`))
    }, limitS * 1000)
  })
  try {
    return await Promise.race([compileLocally(state, t0, body), tooLong])
  } catch (e: any) {
    knownEpoch = null
    if (state.stopped) {
      log(`compile stopped after ${Math.round(performance.now() - t0)} ms`)
      return json({ status: 'terminated', outputFiles: [], pdfCachingMinChunkSize: 0, validationProblems: null })
    }
    log('local compile failed:', e)
    if (settings?.fallbackToServer === false && !(e instanceof Fallback)) throw e
    ext({ type: 'status', state: 'fallback', detail: String(e?.message ?? e), projectId, ms: performance.now() - t0 }).catch(() => undefined)
    showToast(`Compiled on the server: ${e?.message ?? e}`, settings?.toastMs)
    return originalFetch(input, init)
  } finally {
    clearTimeout(timer)
    finishStatus()
    compiling = null
  }
}

async function compileLocally(state: { stopped: boolean; abandoned: boolean }, t0: number, body: any): Promise<Response> {
  {
    // A mirror that failed to start (server hiccup) gets one fresh attempt per compile.
    await mirror!.ready.catch(() => restartMirror())
    const compiler = mirror!.project.compiler as Compiler
    if (!SUPPORTED.includes(compiler)) throw new Fallback(`compiler "${compiler}" isn't supported locally`)
    const main = body.rootResourcePath || (body.rootDoc_id && mirror!.pathOf(body.rootDoc_id))
    if (!main) throw new Fallback('no main document')
    await barrier()
    const options: CompileOptions = { main, compiler, draft: !!body.draft, stopOnFirstError: !!body.stopOnFirstError }
    if (state.abandoned) throw new Error('abandoned after the time limit')
    const result = await compileWithEngine(options)
    if (state.stopped) throw new Error('stopped') // finished anyway (e.g. it was still queued): discard it
    if (result.missingFonts.length && settings?.serverOnMissingFonts) {
      serverOnly = `fonts not available locally: ${result.missingFonts.join(', ')}`
      throw new Fallback(serverOnly)
    }
    if (result.needsShellEscape && settings?.serverOnShellEscape) {
      serverOnly = 'the document runs external programs (shell escape, e.g. minted), which local compiles can\'t'
      throw new Fallback(serverOnly)
    }
    if (result.missingPackages.length && settings?.serverOnMissingPackages) {
      serverOnly = `packages not available locally: ${result.missingPackages.join(', ')}`
      throw new Fallback(serverOnly)
    }
    const build = store.add(projectId, result)
    lastCompile = { status: result.status, passes: result.passes, errors: result.errors, main, ms: result.ms, log: new TextDecoder().decode(result.files['output.log'] ?? new Uint8Array()) }
    log(`compiled ${main} locally: ${result.status}, ${result.passes.length} passes, engine ${Math.round(result.ms)} ms, total ${Math.round(performance.now() - t0)} ms${result.cached ? ' (unchanged)' : ''}`)
    ext({ type: 'status', state: 'local', detail: `last compile ${result.status} in ${(result.ms / 1000).toFixed(1)} s`, projectId, ms: performance.now() - t0, cached: result.cached }).catch(() => undefined)
    return json(compileResponse(store, build, result))
  }
}

class Fallback extends Error {}

/** Output can differ slightly between TeX Live releases: say so once if the project's server image isn't ours. */
function noticeTexLiveYear(local: number) {
  const image = mirror?.project.imageName ?? ''
  const year = Number(image.match(/(?:19|20)\d\d/)?.[0])
  if (year && year !== local) {
    log(`project image ${image} vs local TeX Live ${local}`)
    showToast(`this project uses TeX Live ${year} on the server; local compiles use TeX Live ${local}, so the output can differ slightly.`, settings?.toastMs)
  }
}

async function compileWithEngine(options: CompileOptions): Promise<CompileResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (mirror!.broken) await restartMirror()
    const { sync, commit } = mirror!.takeSync(knownEpoch === null)
    let reply: CompileReply
    try {
      reply = await ext<CompileReply>({ type: 'compile', projectId, clientId, sync, options, expectEpoch: knownEpoch })
    } catch (e: any) {
      // The engine crashed (e.g. out of memory) and was restarted: try once more on the fresh engine.
      if (attempt === 0 && /engine crashed and was restarted/.test(String(e?.message))) {
        log(String(e.message))
        knownEpoch = null
        continue
      }
      throw e
    }
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
  mirror = new ProjectMirror(projectId, getMeta('ol-wsUrl') ?? '', settings!, log, mirrorProgress)
  knownEpoch = null
  await mirror.ready
}

type TreeChange =
  | { kind: 'rename' | 'move'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'newDoc' | 'newFolder' }
  | { kind: 'upload'; folderId: string | null }

/** Overleaf's file tree requests (services/web EditorRouter / UploadsRouter). */
function treeChange(url: URL, method: string): TreeChange | null {
  const p = url.pathname
  let m = p.match(/^\/project\/([^/]+)\/(?:doc|file|folder)\/([^/]+)\/(rename|move)$/)
  if (m && method === 'POST' && m[1] === projectId) return { kind: m[3] as 'rename' | 'move', id: m[2] }
  m = p.match(/^\/project\/([^/]+)\/(?:doc|file|folder)\/([^/]+)$/)
  if (m && method === 'DELETE' && m[1] === projectId) return { kind: 'delete', id: m[2] }
  m = p.match(/^\/project\/([^/]+)\/(doc|folder)$/)
  if (m && method === 'POST' && m[1] === projectId) return { kind: m[2] === 'doc' ? 'newDoc' : 'newFolder' }
  m = p.match(/^\/Project\/([^/]+)\/upload$/i)
  if (m && method === 'POST' && m[1] === projectId) return { kind: 'upload', folderId: url.searchParams.get('folder_id') }
  return null
}

/** File tree requests still in flight: Overleaf updates its tree before the server answers, so a compile can
 *  start before the change reached us. The barrier waits for these. */
const treeRequests = new Set<Promise<unknown>>()

/** Passes the request on and, once it succeeded, applies the change to the mirror right away. */
function trackTreeChange(change: TreeChange, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const p = applyTreeChange(change, input, init)
  const settled = p.catch(() => undefined).finally(() => treeRequests.delete(settled))
  treeRequests.add(settled)
  return p
}

async function applyTreeChange(change: TreeChange, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await originalFetch(input, init)
  if (!res.ok || !mirror) return res
  try {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (change.kind === 'rename' && body.name) mirror.rename(change.id, body.name)
    else if (change.kind === 'move' && body.folder_id) mirror.move(change.id, body.folder_id)
    else if (change.kind === 'delete') mirror.remove(change.id)
    else {
      const data = await res.clone().json()
      if (change.kind === 'newDoc' && data?._id) mirror.addDoc(body.parent_folder_id, data)
      else if (change.kind === 'newFolder' && data?._id) mirror.addFolder({ ...data, docs: [], fileRefs: [], folders: [] }, body.parent_folder_id)
      else if (change.kind === 'upload' && data?.entity_id) mirror.expect(data.entity_id)
    }
    log(`file tree: ${change.kind} applied`)
  } catch (e) {
    log('could not apply a file tree change to the mirror', e)
  }
  return res
}

/** Waits until the mirror has every doc version the editor knows the server has. */
async function barrier() {
  const deadline = performance.now() + (settings?.barrierTimeoutMs ?? 0)
  if (treeRequests.size) await Promise.race([Promise.all([...treeRequests]), new Promise(r => setTimeout(r, Math.max(0, deadline - performance.now())))])
  await mirror!.waitForTree(deadline)
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
  // history-ot docs whose update arrived but whose new text isn't fetched yet
  await mirror!.settle()
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
