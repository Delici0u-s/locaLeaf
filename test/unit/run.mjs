// Bundles test/unit/*.test.ts with esbuild and runs them with node:test.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { ROOT } from '../../scripts/lib.mjs'

const HERE = join(ROOT, 'test/unit')
const OUT = join(HERE, '.build')
const tests = readdirSync(HERE).filter(f => f.endsWith('.test.ts'))
await build({ entryPoints: tests.map(t => join(HERE, t)), bundle: true, platform: 'node', format: 'esm', outdir: OUT, outExtension: { '.js': '.mjs' }, logLevel: 'warning' })
const r = spawnSync(process.execPath, ['--test', ...tests.map(t => join(OUT, t.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' })
process.exit(r.status ?? 1)
