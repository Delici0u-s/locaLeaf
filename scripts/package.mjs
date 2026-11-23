// Builds a clean release (no localeaf.local.json sites, no dev origins) and zips it:
// release/localeaf-<version>.zip. Install: unzip, then "Load unpacked" on the folder.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, readJson } from './lib.mjs'

const version = readJson('package.json').version
const dir = 'dist-release'
execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], {
  stdio: 'inherit',
  // a release must not carry anyone's server address: ignore localeaf.local.json
  env: { ...process.env, OLR_DIST_DIR: dir, LOCALEAF_SITES: '', LOCALEAF_ANY_SITE: '0' },
})
mkdirSync(join(ROOT, 'release'), { recursive: true })
const zip = join(ROOT, 'release', `localeaf-${version}.zip`)
rmSync(zip, { force: true })
execFileSync('zip', ['-q', '-r', '-X', zip, '.', '-x', '*.map'], { cwd: join(ROOT, dir) })
console.log(`release: ${zip}`)
