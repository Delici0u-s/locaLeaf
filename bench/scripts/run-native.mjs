// Times native latexmk (same flags as Overleaf's CLSI) in a long-lived TeX Live container, as the
// reference for what a native helper would get. Usage: node scripts/run-native.mjs [fixture ...]
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BENCH_DIR, FIXTURES_DIR, applyEdit, printTable, selectFixtures, writeResults } from './lib.mjs'

const config = JSON.parse(readFileSync(join(BENCH_DIR, 'bench.config.json'), 'utf8'))
const fixtures = selectFixtures(process.argv.slice(2))
const KIND = process.env.BENCH_RESULTS ?? 'native'
const BUILD_DIR = join(BENCH_DIR, 'build', 'native')
mkdirSync(BUILD_DIR, { recursive: true })

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 26 })
const uid = `${process.getuid()}:${process.getgid()}`
const container = docker(
  'run', '-d', '--rm', '--user', uid, '-e', 'HOME=/tmp',
  '-v', `${BUILD_DIR}:/build:z`, config.native.image, 'sleep', 'infinity'
).trim()

const results = { image: config.native.image, fixtures: [] }
try {
  results.texVersion = docker('exec', container, 'pdftex', '--version').split('\n')[0]
  console.log(results.texVersion)

  for (const fixture of fixtures) {
    // The compile dir is persistent across steps, like CLSI's incremental compiles.
    const dir = join(BUILD_DIR, fixture.name)
    rmSync(dir, { recursive: true, force: true })
    cpSync(join(FIXTURES_DIR, fixture.name), dir, { recursive: true })
    const editPath = join(dir, fixture.edit ?? fixture.main)
    const original = readFileSync(editPath, 'utf8')

    const compile = step => {
      const flag = config.native.compilerFlags[fixture.compiler]
      const args = ['exec', '-w', `/build/${fixture.name}`, container, 'latexmk',
        ...config.native.latexmkFlags, `-auxdir=/build/${fixture.name}`, `-outdir=/build/${fixture.name}`,
        '-f', flag, fixture.main]
      const pdf = join(dir, 'output.pdf')
      const before = existsSync(pdf) ? statSync(pdf).mtimeMs : 0
      const t0 = performance.now()
      let exitCode = 0
      try { docker(...args) } catch (e) { exitCode = e.status ?? -1 }
      const ms = performance.now() - t0
      const produced = existsSync(pdf) && statSync(pdf).mtimeMs >= before
      return { step, ms, exitCode, success: existsSync(pdf), rebuilt: produced, pdfBytes: existsSync(pdf) ? statSync(pdf).size : 0 }
    }

    const runs = [compile('first'), compile('unchanged')]
    let source = original
    for (let n = 1; n <= config.editRounds; n++) {
      source = applyEdit(source, n)
      writeFileSync(editPath, source)
      runs.push(compile(`edit${n}`))
    }
    for (const r of runs) console.log(`${fixture.name} ${r.step}: ${(r.ms / 1000).toFixed(2)}s exit=${r.exitCode} pdf=${r.pdfBytes}B`)
    results.fixtures.push({ name: fixture.name, compiler: fixture.compiler, runs })
    writeResults(KIND, results) // saved after every project, so a crash keeps what finished
  }
} finally {
  docker('rm', '-f', container)
}

const file = writeResults(KIND, results)
printTable(results.fixtures.map(f => ({
  fixture: f.name,
  compiler: f.compiler,
  ...Object.fromEntries(f.runs.map(r => [r.step, `${r.success ? '' : 'fail '}${(r.ms / 1000).toFixed(2)}s`])),
})))
console.log(`\nresults: ${file}`)
