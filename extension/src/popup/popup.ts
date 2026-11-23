// Popup: enable the extension on the current Overleaf site, pick local/server compiling per project,
// show the engine state, and edit settings (generated from the defaults, so new settings appear here).
import { DEFAULT_SETTINGS, STORAGE_KEYS, getStored, mergeSettings, type CompileStats, type ProjectMode } from '../shared/settings'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ? new URL(tab.url) : null
  const origin = url && /^https?:$/.test(url.protocol) ? url.origin : null
  const projectId = url?.pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null
  const origins = await getStored('origins')
  const builtIn = builtInSites()
  const enabled = !!origin && (origins.includes(origin) || builtIn.includes(origin))

  renderSite(origin, enabled, origins, tab?.id, !!origin && builtIn.includes(origin))
  if (enabled) await renderMirrorAccess()
  if (enabled && projectId) await renderProject(projectId, tab?.id)
  await renderStats(projectId)
  renderEngine()
  await renderSettings()
}

/** True if the extension can access these origins, asking the browser only when it can't yet. */
async function ensureAccess(origins: string[]): Promise<boolean> {
  if (await chrome.permissions.contains({ origins })) return true
  try {
    return await chrome.permissions.request({ origins })
  } catch {
    return false
  }
}

/** Sites granted in the manifest at build time (localeaf.local.json): always on, no prompt needed. */
function builtInSites(): string[] {
  const matches = (chrome.runtime.getManifest().content_scripts ?? []).flatMap(c => c.matches ?? [])
  return [...new Set(matches.map(m => m.replace(/\/project\/\*$/, '')))]
}

function renderSite(origin: string | null, enabled: boolean, origins: string[], tabId?: number, builtIn = false) {
  const el = $('site')
  if (!origin) {
    el.innerHTML = '<p class="muted">Open an Overleaf project to enable local compiling there.</p>'
    return
  }
  const button = document.createElement('button')
  const text = document.createElement('p')
  text.className = 'muted'
  if (builtIn) {
    text.textContent = `Enabled on ${origin} (built in via localeaf.local.json).`
    el.replaceChildren(text)
    return
  }
  if (enabled) {
    text.textContent = `Enabled on ${origin}.`
    button.textContent = 'Disable on this site'
    button.onclick = async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.origins]: origins.filter(o => o !== origin) })
      if (tabId !== undefined) chrome.tabs.reload(tabId)
      window.close()
    }
  } else {
    text.textContent = `Compile ${origin} projects locally instead of on the server.`
    button.textContent = 'Enable on this site'
    button.onclick = async () => {
      // The CTAN mirror too: the engine fetches TeX Live packages the bundle doesn't have from it.
      const mirror = new URL(mergeSettings(await getStored('settings')).ctanMirror).origin
      if (!(await ensureAccess([`${origin}/*`, `${mirror}/*`]))) {
        text.textContent = `The browser didn't grant access to ${origin}. Some browsers (Brave) don't show the prompt: ` +
          'add "anySite": true (or this site) to localeaf.local.json, run npm run build and reload LocaLeaf.'
        return
      }
      await chrome.storage.local.set({ [STORAGE_KEYS.origins]: [...origins, origin] })
      if (tabId !== undefined) chrome.tabs.reload(tabId)
      window.close()
    }
  }
  el.replaceChildren(text, button)
}

/** Without access to the CTAN mirror, packages the bundle lacks make projects compile on the server. */
async function renderMirrorAccess() {
  const mirror = new URL(mergeSettings(await getStored('settings')).ctanMirror).origin
  if (await chrome.permissions.contains({ origins: [`${mirror}/*`] })) return
  const p = document.createElement('p')
  p.className = 'muted'
  p.textContent = `No access to the CTAN mirror ${mirror}: projects needing packages outside the built-in bundle compile on the server.`
  const button = document.createElement('button')
  button.textContent = 'Allow access to the mirror'
  button.onclick = async () => {
    if (await ensureAccess([`${mirror}/*`])) { p.remove(); button.remove() }
    else p.textContent = `The browser didn't grant access to ${mirror} (see localeaf.local.json in the README).`
  }
  $('site').append(p, button)
}

async function renderProject(projectId: string, tabId?: number) {
  const el = $('project')
  el.hidden = false
  const modes = await getStored('projectModes')
  const current: ProjectMode = modes[projectId] ?? 'local'
  const row = document.createElement('div')
  row.className = 'row'
  row.append('This project compiles:')
  for (const mode of ['local', 'server'] as ProjectMode[]) {
    const label = document.createElement('label')
    label.style.display = 'inline'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'mode'
    input.checked = mode === current
    input.onchange = async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.projectModes]: { ...modes, [projectId]: mode } })
      if (tabId !== undefined) chrome.tabs.reload(tabId)
    }
    label.append(input, ` ${mode === 'local' ? 'locally' : 'on the server'}`)
    row.append(label)
  }
  el.replaceChildren(row)
}

async function renderStats(projectId: string | null) {
  const stats = await getStored('stats')
  const fmt = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(1)} s`)
  const line = (label: string, s: CompileStats | undefined) => {
    if (!s || s.local + s.server === 0) return null
    const p = document.createElement('p')
    p.className = 'muted'
    const avg = (n: number, ms: number) => (n ? `, avg ${fmt(ms / n)}` : '')
    p.textContent = `${label}: ${s.local} local${avg(s.local, s.localMs)} · ${s.server} on the server${avg(s.server, s.serverMs)} · last ${fmt(s.lastMs)} (${s.lastWhere === 'local' ? 'local' : 'server'})`
    return p
  }
  const rows = [projectId ? line('This project', stats.projects[projectId]) : null, line('All projects', stats.total)].filter((x): x is HTMLParagraphElement => !!x)
  $('stats').replaceChildren(...rows)
}

function renderEngine() {
  chrome.runtime.sendMessage({ type: 'engineStatus' }).then(
    r => { $('engine-status').textContent = r?.state === 'ready' ? `Engine: ready (restart #${r.epoch})` : r?.state === 'error' ? `Engine error: ${r.error}` : 'Engine: not started' },
    () => { $('engine-status').textContent = 'Engine: not started' },
  )
}

/** One input per scalar/array setting, nested objects flattened as "engine.maxPasses". */
async function renderSettings() {
  const stored = await getStored('settings')
  const settings = mergeSettings(stored) as any
  const form = $('settings')
  const fields: [string, unknown][] = []
  const walk = (obj: any, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${prefix}${k}.`)
      else fields.push([`${prefix}${k}`, v])
    }
  }
  walk(DEFAULT_SETTINGS, '')
  const get = (path: string) => path.split('.').reduce((o, k) => o?.[k], settings)
  for (const [path, def] of fields) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    const value = get(path)
    if (typeof def === 'boolean') { input.type = 'checkbox'; input.checked = !!value }
    else if (typeof def === 'number') { input.type = 'number'; input.value = String(value) }
    else { input.type = 'text'; input.value = Array.isArray(value) ? value.join(', ') : String(value ?? '') }
    input.onchange = async () => {
      const parsed = typeof def === 'boolean' ? input.checked : typeof def === 'number' ? Number(input.value) : Array.isArray(def) ? input.value.split(',').map(s => s.trim()).filter(Boolean) : input.value
      const keys = path.split('.')
      const next: any = structuredClone(stored)
      let o = next
      for (const k of keys.slice(0, -1)) o = o[k] ??= {}
      o[keys[keys.length - 1]] = parsed
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next })
    }
    const name = document.createElement('span')
    name.textContent = path
    label.append(name, input)
    form.append(label)
  }
  const note = document.createElement('p')
  note.className = 'muted'
  note.textContent = 'Engine settings apply after the engine restarts (reload the extension); page settings after reloading the Overleaf tab.'
  form.append(note)
}

main()
