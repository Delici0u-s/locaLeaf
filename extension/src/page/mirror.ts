// Live copy of the whole project, kept current through a second real-time (socket.io) connection.
// Docs: joined once, then every op applied as it arrives (history-ot docs are re-fetched instead).
// Files: downloaded once per content hash and cached in IndexedDB across sessions.
// The engine gets diffs computed against what it last received (see takeSync).
import type { SyncPayload } from '../shared/messages'
import type { Settings } from '../shared/settings'
import { getBlob, putBlob } from './blob-cache'
import { applyTextOp, decodeLine, historyOtText, type TextOpComponent } from './ot'
import { connectOwn, type IoSocket } from './socket-hook'

interface Folder { _id: string; name: string; docs?: { _id: string; name: string }[]; fileRefs?: { _id: string; name: string; hash?: string }[]; folders?: Folder[] }
interface Entity { id: string; name: string; kind: 'doc' | 'file' | 'folder'; parent: string | null; hash?: string }
interface DocState {
  text: string
  version: number
  type: string
  rev: number
  /** history-ot: an update arrived but the new text hasn't been fetched yet. */
  stale?: boolean
  refetch?: number
}

export interface ProjectInfo { compiler: string; imageName?: string; rootDoc_id?: string; name?: string }

export class ProjectMirror {
  readonly entities = new Map<string, Entity>()
  private docs = new Map<string, DocState>()
  private files = new Map<string, Uint8Array>()
  private socket!: IoSocket
  private synced = new Map<string, string>() // path → content key the engine has
  project!: ProjectInfo
  ready: Promise<void>
  /** Set when the mirror lost track (disconnect, failed op); the next sync must be a full reset. */
  broken = false

  constructor(private projectId: string, private wsUrl: string, private settings: Settings, private log: (...a: unknown[]) => void, private progress: (text: string) => void = () => {}) {
    this.ready = this.start().catch(e => {
      this.broken = true
      throw e
    })
  }

  private async start() {
    const url = new URL(this.wsUrl || '/socket.io', window.location.origin)
    const socket = connectOwn(url.origin, {
      resource: url.pathname.slice(1),
      'force new connection': true,
      query: new URLSearchParams({ projectId: this.projectId }).toString(),
      reconnect: false,
    })
    this.socket = socket
    const joined = new Promise<{ project: any }>((resolve, reject) => {
      socket.on('joinProjectResponse', resolve)
      socket.on('connectionRejected', (e: any) => reject(new Error(`real-time rejected: ${e?.message ?? e}`)))
      socket.on('error', (e: any) => reject(new Error(`real-time error: ${e?.message ?? e}`)))
    })
    socket.on('disconnect', () => { this.broken = true; this.log('mirror socket disconnected') })
    const { project } = await joined
    this.project = { compiler: project.compiler, imageName: project.imageName, rootDoc_id: project.rootDoc_id, name: project.name }
    this.addFolder(project.rootFolder[0], null)
    this.listen()
    const ids = [...this.entities.values()]
    const docs = ids.filter(e => e.kind === 'doc')
    const files = ids.filter(e => e.kind === 'file')
    let doneDocs = 0
    let doneFiles = 0
    const report = () => this.progress(`loading the project: ${doneDocs}/${docs.length} documents, ${doneFiles}/${files.length} files`)
    report()
    await pool(docs, this.settings.joinConcurrency, async e => { await this.joinDocWithRetry(e.id); doneDocs++; report() })
    await pool(files, this.settings.fetchConcurrency, async e => { await this.fetchFile(e); doneFiles++; report() })
    this.log(`mirror ready: ${this.docs.size} docs, ${this.files.size} files`)
  }

  addFolder(f: Folder, parent: string | null) {
    this.entities.set(f._id, { id: f._id, name: f.name, kind: 'folder', parent })
    for (const d of f.docs ?? []) this.entities.set(d._id, { id: d._id, name: d.name, kind: 'doc', parent: f._id })
    for (const r of f.fileRefs ?? []) this.entities.set(r._id, { id: r._id, name: r.name, kind: 'file', parent: f._id, hash: r.hash })
    for (const sub of f.folders ?? []) this.addFolder(sub, f._id)
  }

  private listen() {
    const s = this.socket
    s.on('otUpdateApplied', (u: { doc: string; v: number; op?: any[] }) => this.onUpdate(u))
    s.on('reciveNewDoc', (parentId: string, doc: { _id: string; name: string }) => this.addDoc(parentId, doc))
    s.on('reciveNewFile', (parentId: string, file: { _id: string; name: string; hash?: string }) => this.addFile(parentId, file))
    s.on('reciveNewFolder', (parentId: string, folder: Folder) => this.addFolder(folder, parentId))
    s.on('reciveEntityRename', (id: string, name: string) => this.rename(id, name))
    s.on('reciveEntityMove', (id: string, folderId: string) => this.move(id, folderId))
    s.on('removeEntity', (id: string) => this.remove(id))
    s.on('compilerUpdated', (c: string) => { this.project.compiler = c })
    s.on('imageNameUpdated', (n: string) => { this.project.imageName = n })
  }

  // File tree changes. Called for the real-time broadcasts and also by the page as soon as Overleaf's own
  // request for the change succeeds (the broadcast can lag on a busy server); applying one twice is harmless.

  addDoc(parentId: string, doc: { _id: string; name: string }) {
    if (this.entities.has(doc._id)) return
    this.entities.set(doc._id, { id: doc._id, name: doc.name, kind: 'doc', parent: parentId })
    this.track(this.joinDocWithRetry(doc._id))
  }

  addFile(parentId: string, file: { _id: string; name: string; hash?: string }) {
    if (this.files.has(file._id) && this.entities.get(file._id)?.hash === file.hash) return
    const e: Entity = { id: file._id, name: file.name, kind: 'file', parent: parentId, hash: file.hash }
    this.entities.set(file._id, e)
    this.track(this.fetchFile(e))
  }

  rename(id: string, name: string) {
    const e = this.entities.get(id)
    if (e) e.name = name
  }

  move(id: string, folderId: string) {
    const e = this.entities.get(id)
    if (e) e.parent = folderId
  }

  /** Content loads started by tree changes; settle() waits for them. */
  private loading = new Set<Promise<void>>()
  private track(p: Promise<void>) {
    const t = p.catch(e => this.fail(e)).finally(() => this.loading.delete(t))
    this.loading.add(t)
  }

  /** Entities Overleaf created (upload) whose broadcast hasn't arrived yet. */
  private expected = new Set<string>()
  expect(id: string) {
    if (!this.entities.has(id)) this.expected.add(id)
  }

  remove(id: string) {
    for (const e of [...this.entities.values()]) if (e.parent === id) this.remove(e.id)
    this.entities.delete(id)
    this.docs.delete(id)
    this.files.delete(id)
  }

  private joinDoc(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.emit('joinDoc', id, { encodeRanges: true, supportsHistoryOT: true }, (err: any, lines: any, version: number, _updates: unknown, _ranges: unknown, type = 'sharejs-text-ot') => {
        if (err) return reject(new Error(`joinDoc ${id}: ${err.message ?? err}`))
        const text = type === 'history-ot' ? historyOtText(lines) : (lines as string[]).map(decodeLine).join('\n')
        const prev = this.docs.get(id)
        this.docs.set(id, { text, version, type, rev: (prev?.rev ?? 0) + 1 })
        resolve()
      })
    })
  }

  /** Busy servers time out on joinDoc now and then (document-updater lock timeouts): retry with backoff. */
  private async joinDocWithRetry(id: string): Promise<void> {
    let delay = this.settings.joinRetryDelayMs
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.joinDoc(id)
      } catch (e) {
        if (attempt >= this.settings.joinRetries) throw e
        this.log(`joinDoc ${id} failed (attempt ${attempt}), retrying in ${delay} ms`)
        await new Promise(r => setTimeout(r, delay))
        delay *= 2
      }
    }
  }

  private rejoin(id: string) {
    this.socket.emit('leaveDoc', id, () => this.joinDocWithRetry(id).catch(e => this.fail(e)))
  }

  private onUpdate(u: { doc: string; v: number; op?: any[] }) {
    const d = this.docs.get(u.doc)
    if (!d || !u.op) return
    if (u.v < d.version) return // already have it
    if (u.v > d.version) { this.log(`gap in ${u.doc} (have v${d.version}, got v${u.v}), rejoining`); this.rejoin(u.doc); return }
    d.version = u.v + 1
    if (d.type === 'history-ot') {
      // We don't carry Overleaf's history-ot implementation; fetch the doc again shortly instead
      // (debounced while someone types). Until then the doc is stale and the compile barrier waits.
      d.stale = true
      clearTimeout(d.refetch)
      d.refetch = window.setTimeout(() => this.rejoin(u.doc), this.settings.historyOtRefetchMs)
      return
    }
    try {
      d.text = applyTextOp(d.text, u.op as TextOpComponent[])
      d.rev++
    } catch (e) {
      this.log(`op did not apply to ${u.doc} (${e}), rejoining`)
      this.rejoin(u.doc)
    }
  }

  private async fetchFile(e: Entity) {
    if (e.hash) {
      const cached = await getBlob(e.hash)
      if (cached) { this.files.set(e.id, cached); return }
    }
    // The file route isn't rate limited; the history blob route is (maxEntitiesPerProject per hour), so it
    // is only the fallback.
    const urls = [`/Project/${this.projectId}/file/${e.id}`, ...(e.hash ? [`/project/${this.projectId}/blob/${e.hash}`] : [])]
    const bytes = await this.download(e.name, urls)
    this.files.set(e.id, bytes)
    if (e.hash) putBlob(e.hash, bytes).catch(() => undefined)
  }

  /** First URL that works; a 429 is retried after its Retry-After if that's within settings.maxRetryAfterMs. */
  private async download(name: string, urls: string[]): Promise<Uint8Array> {
    let last = ''
    for (const url of urls) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(url, { credentials: 'same-origin' })
        if (res.ok) return new Uint8Array(await res.arrayBuffer())
        last = `HTTP ${res.status}`
        const wait = Number(res.headers.get('Retry-After') ?? NaN) * 1000
        if (res.status !== 429 || !(wait <= this.settings.maxRetryAfterMs)) break
        this.log(`download ${name}: rate limited, retrying in ${wait} ms`)
        await new Promise(r => setTimeout(r, wait))
      }
    }
    throw new Error(`download ${name}: ${last}`)
  }

  private fail(e: unknown) {
    this.log('mirror error', e)
    this.broken = true
  }

  pathOf(id: string): string | null {
    const parts: string[] = []
    let e = this.entities.get(id)
    while (e && e.parent !== null) {
      parts.unshift(e.name)
      e = this.entities.get(e.parent)
    }
    return e ? parts.join('/') : null
  }

  /** Doc OT types by path (debugging/tests). */
  docTypes(): Record<string, string> {
    return Object.fromEntries([...this.docs].map(([id, d]) => [this.pathOf(id) ?? id, d.type]))
  }

  docVersion(id: string): number | undefined {
    return this.docs.get(id)?.version
  }

  hasDoc(id: string): boolean {
    return this.docs.has(id)
  }

  /** Waits (until the deadline) for expected new entities to arrive, then for their content. */
  async waitForTree(deadline: number): Promise<void> {
    while ([...this.expected].some(id => !this.entities.has(id)) && performance.now() < deadline) await new Promise(r => setTimeout(r, 20))
    this.expected.clear()
    await Promise.all([...this.loading])
  }

  /** Fetches every stale history-ot doc now instead of after the debounce. */
  async settle(): Promise<void> {
    const stale = [...this.docs].filter(([, d]) => d.stale)
    await Promise.all(stale.map(([id, d]) => {
      clearTimeout(d.refetch)
      return this.refreshDoc(id)
    }))
  }

  /** Re-fetches one doc (used when the editor is ahead and the op never arrived). */
  refreshDoc(id: string): Promise<void> {
    return new Promise(resolve => this.socket.emit('leaveDoc', id, () => this.joinDocWithRetry(id).then(resolve, e => { this.fail(e); resolve() })))
  }

  /** What the engine needs to match the project. Call commitSync() once the engine has it. */
  takeSync(reset: boolean): { sync: SyncPayload; commit: () => void } {
    const current = new Map<string, { key: string; content: string | Uint8Array }>()
    for (const [id, d] of this.docs) {
      const path = this.pathOf(id)
      if (path) current.set(path, { key: `d:${id}:${d.rev}`, content: d.text })
    }
    for (const [id, bytes] of this.files) {
      const e = this.entities.get(id)
      const path = this.pathOf(id)
      if (path && e) current.set(path, { key: `f:${id}:${e.hash ?? bytes.length}`, content: bytes })
    }
    const base = reset ? new Map<string, string>() : this.synced
    const writes = [...current].filter(([p, c]) => base.get(p) !== c.key).map(([path, c]) => ({ path, content: c.content }))
    const deletes = reset ? [] : [...base.keys()].filter(p => !current.has(p))
    const next = new Map([...current].map(([p, c]) => [p, c.key]))
    return { sync: { reset, writes, deletes }, commit: () => { this.synced = next } }
  }

  close() {
    try { this.socket.disconnect() } catch { /* already closed */ }
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  })
  await Promise.all(workers)
}
