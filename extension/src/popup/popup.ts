// Popup: switch LocaLeaf on/off for the current site, pick local/server compiling for the project,
// show compile statistics and engine state, and edit settings (grouped and labelled from
// config/settings.ui.json; anything not described there appears under "Advanced").
import ui from '../../../config/settings.ui.json'
import { DEFAULT_SETTINGS, getStored, mergeSettings, type CompileStats, type ProjectMode } from '../shared/settings'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) => {
  const el = document.createElement(tag)
  const { class: cls, ...rest } = props
  if (cls) el.className = cls
  Object.assign(el, rest)
  el.append(...children)
  return el
}

interface Field { label?: string; help?: string; unit?: string; options?: [string, string][] }
const FIELDS = ui.fields as unknown as Record<string, Field>

async function main() {
  // ?tabId= lets tests (and debugging) open the popup in a tab for a given Overleaf tab.
  const forced = Number(new URLSearchParams(location.search).get('tabId'))
  const tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  const url = tab?.url ? new URL(tab.url) : null
  const origin = url && /^https?:$/.test(url.protocol) ? url.origin : null
  const projectId = url?.pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null
  const origins = await getStored('origins')
  const builtIn = builtInSites()
  const enabled = !!origin && (origins.includes(origin) || builtIn.includes(origin))

  renderEngine()
  await renderSite(origin, enabled, builtIn.includes(origin ?? ''), origins, tab?.id)
  if (enabled && projectId) await renderProject(projectId, tab?.id)
  await renderStats(projectId)
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

/** Sites granted in the manifest at build time (localeaf.local.json "sites"): always on, no prompt needed. */
function builtInSites(): string[] {
  const matches = (chrome.runtime.getManifest().content_scripts ?? []).flatMap(c => c.matches ?? [])
  return [...new Set(matches.map(m => m.replace(/\/project\/\*$/, '')))]
}

function engineStatus(): Promise<{ state?: string; epoch?: number; error?: string } | undefined> {
  return chrome.runtime.sendMessage({ type: 'engineStatus' }).catch(() => undefined)
}

async function renderEngine() {
  const pill = $('engine')
  const r = await engineStatus()
  pill.className = `pill ${r?.state === 'ready' ? 'ready' : r?.state === 'error' ? 'error' : ''}`
  pill.textContent = r?.state === 'ready' ? 'engine ready' : r?.state === 'error' ? 'engine error' : 'engine idle'
  pill.title = r?.state === 'error' ? r.error ?? '' : r?.state === 'ready' ? 'The TeX engine is running.' : 'Starts when you open an enabled Overleaf project.'
}

async function renderSite(origin: string | null, enabled: boolean, builtIn: boolean, origins: string[], tabId?: number) {
  const el = $('site')
  if (!origin) {
    el.replaceChildren(h('h2', {}, 'This site'), h('p', { class: 'muted' }, 'Open an Overleaf project to compile it locally.'))
    return
  }
  const host = new URL(origin).host
  const input = h('input', { type: 'checkbox', checked: enabled, disabled: builtIn })
  input.setAttribute('aria-label', `LocaLeaf on ${host}`)
  const note = h('p', { class: 'muted' }, builtIn ? 'Always on: built in via localeaf.local.json.' : enabled ? 'Compiles happen in this browser.' : 'Off: Overleaf compiles on its server as usual.')
  el.replaceChildren(
    h('h2', {}, 'This site'),
    h('div', { class: 'switch-row' }, h('div', { class: 'what' }, h('strong', {}, host), note), h('label', { class: 'switch' }, input, h('span'))),
  )
  input.onchange = async () => {
    if (input.checked) {
      const mirror = new URL(mergeSettings(await getStored('settings')).ctanMirror).origin
      if (!(await ensureAccess([`${origin}/*`, `${mirror}/*`]))) {
        input.checked = false
        el.append(h('p', { class: 'warn' }, `The browser didn't grant access to ${host}. Some browsers (Brave) never show the prompt: put "anySite": true or this site into localeaf.local.json, run npm run build and reload LocaLeaf.`))
        return
      }
      await chrome.storage.local.set({ origins: [...new Set([...origins, origin])] })
    } else {
      await chrome.storage.local.set({ origins: origins.filter(o => o !== origin) })
    }
    if (tabId !== undefined) chrome.tabs.reload(tabId)
    window.close()
  }
  if (enabled) await renderMirrorAccess(el)
}

/** Without access to the CTAN mirror, packages the bundle lacks make projects compile on the server. */
async function renderMirrorAccess(el: HTMLElement) {
  const mirror = new URL(mergeSettings(await getStored('settings')).ctanMirror).origin
  if (await chrome.permissions.contains({ origins: [`${mirror}/*`] })) return
  const button = h('button', { type: 'button' }, 'Allow access to the mirror')
  const text = h('span', {}, `No access to the CTAN mirror ${new URL(mirror).host}: projects needing packages outside the built-in bundle compile on the server.`)
  const warn = h('div', { class: 'warn' }, text, h('br'), button)
  button.onclick = async () => {
    if (await ensureAccess([`${mirror}/*`])) warn.remove()
    else text.textContent = `The browser didn't grant access to ${mirror} (see localeaf.local.json in the README).`
  }
  el.append(warn)
}

async function renderProject(projectId: string, tabId?: number) {
  const el = $('project')
  el.hidden = false
  const modes = await getStored('projectModes')
  const current: ProjectMode = modes[projectId] ?? 'local'
  const choice = (mode: ProjectMode, label: string) => {
    const b = h('button', { type: 'button' }, label)
    b.setAttribute('aria-pressed', String(mode === current))
    b.onclick = async () => {
      if (mode === current) return
      await chrome.storage.local.set({ projectModes: { ...modes, [projectId]: mode } })
      if (tabId !== undefined) chrome.tabs.reload(tabId)
      window.close()
    }
    return b
  }
  el.replaceChildren(
    h('h2', {}, 'This project compiles'),
    h('div', { class: 'segmented', role: 'group' }, choice('local', 'Locally'), choice('server', 'On the server')),
    h('p', { class: 'muted' }, 'Switching reloads the tab.'),
  )
}

async function renderStats(projectId: string | null) {
  const stats = await getStored('stats')
  const s = projectId ? stats.projects[projectId] : undefined
  const total = stats.total
  if (!total || total.local + total.server === 0) return
  const sec = (ms: number) => `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`
  const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60_000)
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
  }
  const tile = (n: string, l: string) => h('div', { class: 'tile' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l))
  const tilesFor = (x: CompileStats) => h('div', { class: 'tiles' },
    tile(String(x.local), x.local ? `local · avg ${sec(x.localMs / x.local)}` : 'local'),
    tile(String(x.server), x.server ? `on the server · avg ${sec(x.serverMs / x.server)}` : 'on the server'),
    tile(sec(x.lastMs), `last (${x.lastWhere === 'local' ? 'local' : 'server'}, ${ago(x.lastAt)})`),
  )
  const el = $('stats')
  el.hidden = false
  const parts: Node[] = [h('h2', {}, s && s.local + s.server > 0 ? 'This project' : 'Compiles')]
  if (s && s.local + s.server > 0) parts.push(tilesFor(s), h('p', { class: 'muted' }, `All projects: ${total.local} local, ${total.server} on the server.`))
  else parts.push(tilesFor(total))
  el.replaceChildren(...parts)
}

/** All scalar/array settings as "a.b" paths. */
function settingPaths(obj: any, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? settingPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`]))
}

async function renderSettings() {
  const stored = await getStored('settings')
  const effective = mergeSettings(stored) as any
  const get = (o: any, path: string) => path.split('.').reduce((x, k) => x?.[k], o)
  const all = settingPaths(DEFAULT_SETTINGS)
  const listed = new Set(ui.groups.flatMap(g => g.keys))
  const groups = [...ui.groups, { title: 'Advanced', keys: all.filter(p => !listed.has(p)) }]

  const save = async (path: string, value: unknown) => {
    const next: any = structuredClone(await getStored('settings'))
    const keys = path.split('.')
    let o = next
    for (const k of keys.slice(0, -1)) o = o[k] ??= {}
    o[keys[keys.length - 1]] = value
    await chrome.storage.local.set({ settings: next })
  }

  const field = (path: string) => {
    const meta = FIELDS[path] ?? {}
    const def = get(DEFAULT_SETTINGS, path)
    const value = get(effective, path)
    const id = `s-${path}`
    const label = h('label', { htmlFor: id }, meta.label ?? path)
    let control: HTMLElement
    let wide = false
    if (meta.options) {
      const select = h('select', { id })
      for (const [v, l] of meta.options) select.append(h('option', { value: v, selected: v === value }, l))
      select.onchange = () => save(path, select.value)
      control = select
      wide = true
    } else if (typeof def === 'boolean') {
      const input = h('input', { type: 'checkbox', id, checked: !!value })
      input.onchange = () => save(path, input.checked)
      control = h('label', { class: 'switch' }, input, h('span'))
    } else if (typeof def === 'number') {
      const input = h('input', { type: 'number', id, value: String(value) })
      input.onchange = () => save(path, Number(input.value))
      control = h('span', {}, input, ...(meta.unit ? [h('span', { class: 'unit' }, meta.unit)] : []))
    } else {
      const input = h('input', { type: 'text', id, value: Array.isArray(value) ? value.join(', ') : String(value ?? '') })
      input.onchange = () => save(path, Array.isArray(def) ? input.value.split(',').map(s => s.trim()).filter(Boolean) : input.value)
      control = input
      wide = true
    }
    const row = h('div', { class: `field${wide ? ' wide' : ''}` }, label, control)
    if (meta.help) row.append(h('p', { class: 'help' }, meta.help))
    return row
  }

  $('groups').replaceChildren(...groups.filter(g => g.keys.length).map(g => h('details', {}, h('summary', {}, g.title), ...g.keys.map(field))))
  $('groups').append(h('p', { class: 'muted' }, 'Changes apply when you reload the Overleaf tab (engine settings: when the engine restarts).'))
  $('reset').onclick = async () => {
    await chrome.storage.local.remove('settings')
    await renderSettings()
  }
}

main()
