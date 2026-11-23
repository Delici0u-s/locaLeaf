// Pure helpers for the rerun logic ("mini latexmk"). No WASM or DOM here, so they're unit-testable.

/** 32-bit FNV-1a over bytes, as hex. Enough to tell whether a file changed between two runs. */
export function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0') + bytes.length.toString(16)
}

export function hashText(text: string): string {
  return hashBytes(new TextEncoder().encode(text))
}

/** Same snapshot? Both are maps path → hash. */
export function sameSnapshot(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** The parts of .aux files that decide whether bibtex must run again. */
export function bibtexKey(auxTexts: string[]): string | null {
  const lines: string[] = []
  let hasBibdata = false
  for (const text of auxTexts) {
    for (const line of text.split('\n')) {
      if (line.startsWith('\\bibdata')) hasBibdata = true
      if (/^\\(citation|bibdata|bibstyle)\{/.test(line)) lines.push(line)
    }
  }
  return hasBibdata ? lines.join('\n') : null
}

/** Lines starting with "!" are TeX errors (same rule as Overleaf's log parser). */
export function countErrors(log: string): number {
  let n = 0
  for (const line of log.split('\n')) if (line.startsWith('!')) n++
  return n
}

/** Errors caused by packages that run external programs (minted, svg/Inkscape, gnuplot, …): the WASM engine has no
 *  shell escape, Overleaf's server may. Only counts when the log has errors. */
export function needsShellEscape(log: string): boolean {
  if (countErrors(log) === 0) return false
  return /Shell escape disabled|-shell-escape|shell escape|executable is unavailable|\\write18/i.test(log)
}

/** Font names fontspec couldn't find ("The font "X" cannot be found"), from a TeX log. */
export function missingFonts(log: string): string[] {
  const joined = log.replace(/\n\(fontspec\)\s+/g, ' ')
  const out = new Set<string>()
  for (const m of joined.matchAll(/The font "([^"]+)" cannot\s+be\s+found/g)) out.add(m[1])
  return [...out]
}

/** Files TeX asked for and didn't get ("File `x.sty' not found", "I can't find file `x'"). */
export function missingFiles(log: string): string[] {
  const out = new Set<string>()
  for (const m of log.matchAll(/^! LaTeX Error: File `([^']+)' not found\./gm)) out.add(m[1])
  for (const m of log.matchAll(/^! I can't find file `([^']+)'/gm)) out.add(m[1])
  for (const m of log.matchAll(/^! Font \\\S+=(\S+) at [^ ]+ not loadable: Metric \(TFM\) file not found/gm)) out.add(`${m[1]}.tfm`)
  return [...out]
}

/** Missing files that look like TeX Live packages rather than project files the user mistyped. */
export function missingPackages(missing: string[], sources: Iterable<string>): string[] {
  const projectNames = new Set<string>()
  for (const p of sources) {
    projectNames.add(p)
    projectNames.add(p.replace(/\.tex$/, ''))
    const base = p.slice(p.lastIndexOf('/') + 1)
    projectNames.add(base)
    projectNames.add(base.replace(/\.tex$/, ''))
  }
  return missing.filter(f => !projectNames.has(f) && /\.(sty|cls|bst|def|cfg|clo|fd|tfm|ldf|bbx|cbx|lbx|code\.tex)$/.test(f))
}

/** Normalizes a font name the way config/font-index.json keys are. */
export function fontKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '')
}

/** CLSI's draft mode: prepended to the main file (services/clsi/app/js/DraftModeManager.js). */
export const DRAFT_PREFIX = '\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{draft}{graphics}'

export function applyDraft(source: Uint8Array, draft: boolean): Uint8Array {
  if (!draft) return source
  const prefix = new TextEncoder().encode(DRAFT_PREFIX)
  const out = new Uint8Array(prefix.length + source.length)
  out.set(prefix)
  out.set(source, prefix.length)
  return out
}

export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/')
}
