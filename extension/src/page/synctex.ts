// Answers Overleaf's /sync/code and /sync/pdf requests from a local build's output.synctex.gz.
import type { Build } from './outputs'
import { editPosition, parseSyncTex, projectPath, viewPositions, type SyncTexData } from './synctex-parse'

async function load(build: Build): Promise<SyncTexData | null> {
  build.synctex ??= (async () => {
    const gz = build.files['output.synctex.gz']
    if (!gz) return null
    const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
    return parseSyncTex(await new Response(stream).text())
  })()
  return build.synctex
}

export async function syncFromCode(build: Build, q: URLSearchParams) {
  const data = await load(build)
  if (!data) return { pdf: [] }
  const file = q.get('file') ?? ''
  const tags = [...data.inputs].filter(([, p]) => projectPath(p, build.outputDir, build.projectRoot) === file).map(([t]) => t)
  return { pdf: viewPositions(data, tags, Number(q.get('line'))) }
}

export async function syncFromPdf(build: Build, q: URLSearchParams) {
  const data = await load(build)
  if (!data) return { code: [] }
  const hit = editPosition(data, Number(q.get('page')), Number(q.get('h')), Number(q.get('v')))
  if (!hit) return { code: [] }
  const file = projectPath(data.inputs.get(hit.tag) ?? '', build.outputDir, build.projectRoot)
  return { code: file ? [{ file, line: hit.line, column: Math.max(0, hit.column) }] : [] }
}
