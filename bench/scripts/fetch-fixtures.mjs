// Downloads every project listed in fixtures.json into fixtures/<name>/ as an Overleaf-like project root.
// Usage: node scripts/fetch-fixtures.mjs [name ...]   (no names = all; existing folders are left alone)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { loadFixtures, FIXTURES_DIR } from './lib.mjs'

const wanted = process.argv.slice(2)
const fixtures = loadFixtures().filter(f => wanted.length === 0 || wanted.includes(f.name))

for (const fixture of fixtures) {
  const target = join(FIXTURES_DIR, fixture.name)
  if (existsSync(target)) {
    console.log(`= ${fixture.name}: already present`)
    continue
  }
  const work = mkdtempSync(join(tmpdir(), `olr-fixture-${fixture.name}-`))
  try {
    const root = download(fixture.source, work)
    mkdirSync(target, { recursive: true })
    cpSync(join(root, fixture.source.path), target, {
      recursive: true,
      dereference: true, // symlinks become real files, as in an uploaded Overleaf project
      filter: src => !src.split('/').includes('.git'),
    })
    for (const file of fixture.include ?? []) {
      cpSync(join(root, file), join(target, basename(file)), { dereference: true })
    }
    for (const [from, to] of Object.entries(fixture.move ?? {})) {
      mkdirSync(dirname(join(target, to)), { recursive: true })
      renameSync(join(target, from), join(target, to))
    }
    console.log(`+ ${fixture.name}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function download(source, work) {
  if (source.type === 'git') {
    const dir = join(work, 'repo')
    execFileSync('git', ['clone', '--quiet', '--depth', '1', source.repo, dir], { stdio: 'inherit' })
    return dir
  }
  if (source.type === 'archive') {
    const file = join(work, source.url.split('/').pop())
    execFileSync('curl', ['-sSfL', '-o', file, source.url], { stdio: 'inherit' })
    const dir = join(work, 'extracted')
    mkdirSync(dir)
    if (file.endsWith('.zip')) execFileSync('unzip', ['-q', file, '-d', dir])
    else execFileSync('tar', ['-xf', file, '-C', dir])
    return dir
  }
  throw new Error(`unknown source type: ${source.type}`)
}
