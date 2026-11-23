// Minimal SyncTeX reader: enough for forward search (source line → PDF boxes) and reverse search
// (PDF point → source line), with the same conventions as the `synctex` CLI that Overleaf's CLSI wraps:
// positions in PDF big points from the page's top-left; view results report v = baseline + depth and
// H = height + depth.

export interface SyncNode {
  kind: string // '[' '(' 'v' 'h' 'x' 'k' 'g' '$'
  tag: number
  line: number
  column: number
  h: number
  v: number
  W: number
  H: number
  D: number
  page: number
  depth: number // nesting depth of the box (inner boxes are more specific)
  parent: number // index of the enclosing box record in SyncTexData.nodes, or -1
}

export interface SyncTexData {
  inputs: Map<number, string>
  nodes: SyncNode[]
}

const SP_PER_BP = 65781.76

export function parseSyncTex(text: string): SyncTexData {
  const inputs = new Map<number, string>()
  const nodes: SyncNode[] = []
  let unit = 1
  let mag = 1000
  let xOffset = 0
  let yOffset = 0
  let page = 0
  let depth = 0
  const open: number[] = [] // indices of the boxes currently open
  let inContent = false
  const toBp = (x: number) => (x * unit * mag) / 1000 / SP_PER_BP

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!line) continue
    if (line.startsWith('Input:')) {
      const rest = line.slice(6)
      const i = rest.indexOf(':')
      inputs.set(Number(rest.slice(0, i)), rest.slice(i + 1))
      continue
    }
    if (!inContent) {
      if (line.startsWith('Unit:')) unit = Number(line.slice(5))
      else if (line.startsWith('Magnification:')) mag = Number(line.slice(14))
      else if (line.startsWith('X Offset:')) xOffset = Number(line.slice(9))
      else if (line.startsWith('Y Offset:')) yOffset = Number(line.slice(9))
      else if (line.startsWith('Content:')) inContent = true
      continue
    }
    if (line.startsWith('Postamble:')) break
    const c = line[0]
    if (c === '{') { page = Number(line.slice(1)); depth = 0; open.length = 0; continue }
    if (c === '}' || c === '!') continue
    if (c === ']' || c === ')') { depth--; open.pop(); continue }
    if (!'[(vhxkg$'.includes(c)) continue
    const m = line.slice(1).match(/^(\d+),(\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/)
    if (!m) continue
    const node: SyncNode = {
      kind: c, tag: Number(m[1]), line: Number(m[2]), column: m[3] ? Number(m[3]) : -1,
      h: toBp(Number(m[4]) + xOffset), v: toBp(Number(m[5]) + yOffset),
      W: m[6] ? toBp(Number(m[6])) : 0, H: m[7] ? toBp(Number(m[7])) : 0, D: m[8] ? toBp(Number(m[8])) : 0,
      page, depth, parent: open.length ? open[open.length - 1] : -1,
    }
    nodes.push(node)
    if (c === '[' || c === '(') { depth++; open.push(nodes.length - 1) }
  }
  return { inputs, nodes }
}

export interface PdfPosition { page: number; h: number; v: number; width: number; height: number }

/** Forward search: boxes for `line` of the input whose normalized path is `file`. */
export function viewPositions(data: SyncTexData, tags: number[], line: number): PdfPosition[] {
  if (!tags.length) return []
  const records = data.nodes.filter(n => tags.includes(n.tag))
  if (!records.length) return []
  // Exact line, else the closest line after it.
  let matching = records.filter(n => n.line === line)
  if (!matching.length) {
    const target = records.filter(n => n.line > line).sort((a, b) => a.line - b.line)[0]?.line
    matching = target === undefined ? [] : records.filter(n => n.line === target)
  }
  // Like `synctex view`: report the horizontal box each record sits in (TeX tags a paragraph's line boxes
  // with where the paragraph ended, but the glyphs inside carry their own source line).
  const candidates: SyncNode[] = []
  for (const n of matching) {
    let box: SyncNode | undefined = n
    while (box && box.kind !== '(' && box.kind !== 'h') box = box.parent >= 0 ? data.nodes[box.parent] : undefined
    if (box) candidates.push(box)
  }
  const seen = new Set<string>()
  const out: PdfPosition[] = []
  for (const n of candidates) {
    const p = { page: n.page, h: round(n.h), v: round(n.v + n.D), width: round(n.W), height: round(n.H + n.D) }
    const key = `${p.page}:${p.h}:${p.v}:${p.width}`
    if (!seen.has(key) && p.width > 0) { seen.add(key); out.push(p) }
  }
  return out
}

/** Reverse search: the source position under a PDF point. */
export function editPosition(data: SyncTexData, page: number, h: number, v: number): { tag: number; line: number; column: number } | null {
  const onPage = data.nodes.filter(n => n.page === page)
  const containing = onPage.filter(n => (n.kind === '(' || n.kind === 'h' || n.kind === '[') && n.W > 0 && h >= n.h && h <= n.h + n.W && v >= n.v - n.H && v <= n.v + n.D)
  // The innermost horizontal box around the point (smallest area), as synctex does.
  containing.sort((a, b) => a.W * (a.H + a.D) - b.W * (b.H + b.D) || b.depth - a.depth)
  const box = containing.find(n => n.kind !== '[') ?? containing[0]
  if (box) {
    // Prefer the closest glyph-level record on the same baseline inside the box: its line is the most precise.
    const inside = onPage.filter(n => 'xkg$'.includes(n.kind) && n.v === box.v && n.h >= box.h && n.h <= box.h + box.W)
    inside.sort((a, b) => Math.abs(a.h - h) - Math.abs(b.h - h))
    const best = inside[0] ?? box
    return { tag: best.tag, line: best.line, column: best.column }
  }
  // Nothing contains it: nearest record on the page.
  let best: SyncNode | null = null
  let dist = Infinity
  for (const n of onPage) {
    const d = Math.hypot(n.h - h, n.v - v)
    if (d < dist) { dist = d; best = n }
  }
  return best ? { tag: best.tag, line: best.line, column: best.column } : null
}

/** Maps a path TeX recorded (relative to the output dir, or absolute in the engine FS) to a project path. */
export function projectPath(recorded: string, outputDir: string, projectRoot: string): string | null {
  let p = recorded
  if (p.startsWith('/')) {
    if (!p.startsWith(projectRoot + '/')) return null // a TeX Live file, not part of the project
    p = p.slice(projectRoot.length + 1)
  } else {
    p = [outputDir, p].filter(Boolean).join('/')
  }
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

function round(x: number): number {
  return Math.round(x * 100) / 100
}
