// Shared helpers for the benchmark scripts: fixture manifest, project file listing, the edit step, results.
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURES_DIR = join(BENCH_DIR, 'fixtures')
export const RESULTS_DIR = join(BENCH_DIR, 'results')

export function loadFixtures() {
  return JSON.parse(readFileSync(join(BENCH_DIR, 'fixtures.json'), 'utf8')).fixtures
}

export function selectFixtures(names) {
  const all = loadFixtures()
  const unknown = names.filter(n => !all.some(f => f.name === n))
  if (unknown.length) throw new Error(`unknown fixtures: ${unknown.join(', ')}`)
  return names.length ? all.filter(f => names.includes(f.name)) : all
}

// All files of a project, as paths relative to its root. Symlinks are skipped: Overleaf projects have none.
export function listProjectFiles(root) {
  const out = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(full)
      else out.push(relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

// The one-line change used for the "recompile after an edit" measurement.
export function applyEdit(source, n) {
  const marker = '\\end{document}'
  const at = source.lastIndexOf(marker)
  if (at < 0) return `${source}\n\\par Benchmark edit ${n}.\n`
  return `${source.slice(0, at)}\\par Benchmark edit ${n}.\n${source.slice(at)}`
}

export function writeResults(kind, results) {
  mkdirSync(RESULTS_DIR, { recursive: true })
  const file = join(RESULTS_DIR, `${kind}.json`)
  writeFileSync(file, JSON.stringify({ kind, date: new Date().toISOString(), results }, null, 2) + '\n')
  return file
}

export function printTable(rows) {
  const cols = Object.keys(rows[0] ?? {})
  const width = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)))
  const line = r => cols.map((c, i) => String(r[c]).padEnd(width[i])).join('  ')
  console.log(line(Object.fromEntries(cols.map(c => [c, c]))))
  for (const r of rows) console.log(line(r))
}
