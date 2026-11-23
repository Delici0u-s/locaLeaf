// Packs each fixture folder into zips/<name>.zip (files at the zip root), ready for Overleaf's
// "New Project → Upload Project". Usage: node scripts/zip-fixtures.mjs [name ...]
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BENCH_DIR, FIXTURES_DIR, selectFixtures } from './lib.mjs'

const ZIPS_DIR = join(BENCH_DIR, 'zips')
mkdirSync(ZIPS_DIR, { recursive: true })
for (const fixture of selectFixtures(process.argv.slice(2))) {
  const zip = join(ZIPS_DIR, `${fixture.name}.zip`)
  rmSync(zip, { force: true }) // regenerated from fixtures/, never edited by hand
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: join(FIXTURES_DIR, fixture.name) })
  console.log(`${fixture.name}.zip  main: ${fixture.main}  compiler: ${fixture.compiler}`)
}
