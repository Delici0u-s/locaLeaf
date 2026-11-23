// Holds local build outputs and answers requests for them, as the compile server would.
import type { CompileResult } from '../engine/protocol'

export const OUTPUT_PREFIX = '/__olr/'

export interface Build {
  projectId: string
  id: string
  files: Record<string, Uint8Array>
  blobUrls: string[]
  /** Where the engine compiled (for mapping synctex paths back to project paths). */
  outputDir: string
  projectRoot: string
  synctex?: Promise<import('./synctex-parse').SyncTexData | null>
}

const MIME: Record<string, string> = { pdf: 'application/pdf', log: 'text/plain; charset=utf-8', blg: 'text/plain; charset=utf-8', aux: 'text/plain; charset=utf-8', bbl: 'text/plain; charset=utf-8', gz: 'application/gzip' }

export class OutputStore {
  private builds: Build[] = []

  constructor(private keep: () => number) {}

  add(projectId: string, result: CompileResult): Build {
    const id = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
    const build: Build = { projectId, id, files: result.files, blobUrls: [], outputDir: result.outputDir, projectRoot: result.projectRoot }
    this.builds.push(build)
    while (this.builds.length > Math.max(1, this.keep())) {
      for (const u of this.builds.shift()!.blobUrls) URL.revokeObjectURL(u)
    }
    return build
  }

  url(build: Build, name: string): string {
    return `${OUTPUT_PREFIX}${build.projectId}/${build.id}/${name}`
  }

  blobUrl(build: Build, name: string): string {
    const u = URL.createObjectURL(new Blob([build.files[name] as BlobPart], { type: mimeOf(name) }))
    build.blobUrls.push(u)
    return u
  }

  lookup(pathname: string): { build: Build; name: string; bytes: Uint8Array } | null {
    if (!pathname.startsWith(OUTPUT_PREFIX)) return null
    const [projectId, buildId, ...rest] = pathname.slice(OUTPUT_PREFIX.length).split('/')
    const name = decodeURIComponent(rest.join('/'))
    const build = this.builds.find(b => b.projectId === projectId && b.id === buildId)
    const bytes = build?.files[name]
    return build && bytes ? { build, name, bytes } : null
  }

  latest(projectId: string): Build | undefined {
    for (let i = this.builds.length - 1; i >= 0; i--) if (this.builds[i].projectId === projectId) return this.builds[i]
    return undefined
  }

  /** A Response for a GET, honouring Range (pdf.js loads PDFs in ranges). */
  respond(pathname: string, rangeHeader: string | null): Response {
    const hit = this.lookup(pathname)
    if (!hit) return new Response('not found', { status: 404 })
    const { bytes, name } = hit
    const headers: Record<string, string> = { 'Content-Type': mimeOf(name), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
    const m = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/)
    if (m) {
      const start = Number(m[1])
      const end = Math.min(m[2] ? Number(m[2]) : bytes.length - 1, bytes.length - 1)
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } })
      const part = bytes.slice(start, end + 1)
      return new Response(part, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(part.length) } })
    }
    return new Response(bytes.slice(), { status: 200, headers: { ...headers, 'Content-Length': String(bytes.length) } })
  }
}

export function mimeOf(name: string): string {
  return MIME[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
}

/** Overleaf's CompileResponseData for a local build (see services/web/types/compile.ts). */
export function compileResponse(store: OutputStore, build: Build, result: CompileResult) {
  const outputFiles = Object.keys(build.files).sort().map(name => {
    const ext = name.slice(name.lastIndexOf('.') + 1)
    const file: Record<string, unknown> = {
      path: name,
      url: store.url(build, name),
      type: name.endsWith('.synctex.gz') ? 'gz' : ext,
      build: build.id,
      downloadURL: store.blobUrl(build, name),
    }
    if (name === 'output.pdf') Object.assign(file, { size: build.files[name].length, ranges: [], contentId: build.id, createdAt: new Date().toISOString() })
    return file
  })
  return {
    status: result.status,
    outputFiles,
    compileGroup: 'local',
    clsiServerId: 'olr-local',
    clsiCacheShard: 'olr-local',
    fromCache: true, // makes the download button use downloadURL (a blob: URL) directly
    pdfCachingMinChunkSize: 0,
    validationProblems: null,
    stats: { 'olr-passes': result.passes.length, 'olr-errors': result.errors },
    timings: { compile: Math.round(result.ms), compileE2E: Math.round(result.ms) },
  }
}
