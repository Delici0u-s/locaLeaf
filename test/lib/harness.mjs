// Shared test harness: a hard deadline for the whole script, bounded waits, live timestamped progress,
// and diagnostics (screenshots of tracked pages + their console logs) when something hangs or fails.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, readJson } from '../../scripts/lib.mjs'

const cfg = readJson('config/test.json')
const pick = (table, name) => table[name] ?? table.default

export function harness(name) {
  const deadlineMs = Number(process.env.OLR_TEST_DEADLINE_MS ?? pick(cfg.deadline, name))
  const stepMs = Number(process.env.OLR_TEST_STEP_MS ?? pick(cfg.step, name))
  const t0 = Date.now()
  const pages = new Map() // label → { page, logs }
  const cleanups = []
  let current = 'starting'

  const stamp = () => `[${name} +${((Date.now() - t0) / 1000).toFixed(1)}s]`
  const step = msg => {
    current = msg
    console.log(`${stamp()} ${msg}`)
  }

  async function saveArtifacts(reason) {
    const dir = join(ROOT, 'test/.artifacts', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'reason.txt'), `${reason}\nlast step: ${current}\n`)
    for (const [label, { page, logs }] of pages) {
      writeFileSync(join(dir, `${label}.console.log`), logs.join('\n') + '\n')
      try { await page.screenshot({ path: join(dir, `${label}.png`), timeout: 5000 }) } catch { /* page gone */ }
    }
    console.error(`${stamp()} diagnostics saved to ${dir}`)
  }

  const timer = setTimeout(async () => {
    console.error(`${stamp()} DEADLINE of ${deadlineMs / 1000}s exceeded — stuck at: ${current}`)
    await Promise.race([saveArtifacts(`deadline exceeded`), new Promise(r => setTimeout(r, 15000))])
    for (const c of cleanups) { try { await Promise.race([c(), new Promise(r => setTimeout(r, 5000))]) } catch {} }
    process.exit(124)
  }, deadlineMs)
  timer.unref?.()

  return {
    stepMs,
    pdfTextMs: Number(cfg.pdfTextMs),
    step,
    /** Keeps a page's console output (all of it) for diagnostics; returns the log array. */
    track(label, page) {
      const logs = []
      page.on('console', m => logs.push(`${new Date().toISOString()} [${m.type()}] ${m.text()}`))
      page.on('pageerror', e => logs.push(`${new Date().toISOString()} [pageerror] ${e.message}`))
      pages.set(label, { page, logs })
      return logs
    },
    /** Polls fn until it returns a truthy value; throws after ms with what it was waiting for. */
    async waitFor(what, fn, ms = stepMs, every = 200) {
      const start = Date.now()
      for (;;) {
        const v = await fn()
        if (v) return v
        if (Date.now() - start > ms) throw new Error(`timed out after ${ms / 1000}s waiting for: ${what}`)
        await new Promise(r => setTimeout(r, every))
      }
    },
    onCleanup(fn) { cleanups.push(fn) },
    saveArtifacts,
    done() { clearTimeout(timer) },
  }
}

/** Fails fast with a clear message when the dev Overleaf isn't running. */
export async function preflight(url) {
  try {
    const r = await fetch(`${url}/login`, { signal: AbortSignal.timeout(cfg.preflightMs) })
    if (r.ok) return
    throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.error(`Overleaf at ${url} isn't reachable (${e.message}). Start it: docker compose -f dev/overleaf-ce/compose.yml up -d`)
    process.exit(2)
  }
}
