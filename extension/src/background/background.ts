// Background service worker: offscreen engine lifecycle, per-origin script registration, badge.
import { EMPTY_STATS, STORAGE_KEYS, getStored, mergeSettings, type CompileStats } from '../shared/settings'
import { lastKey, liveKey, type BackgroundRequest, type LastCompile, type LiveState } from '../shared/messages'
import engineConfig from '../../../config/engine.json'

const OFFSCREEN_URL = 'offscreen.html'
const SCRIPT_IDS = { page: 'olr-page', content: 'olr-content' }

let offscreenReady: Promise<void> | null = null
let resolveOffscreenReady: (() => void) | null = null

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })
  return contexts.length > 0
}

async function ensureEngine(): Promise<void> {
  if (await hasOffscreen()) {
    // Chrome stops this service worker when idle while the engine document keeps running; a restarted worker
    // must not wait for a "ready" message that was sent long ago. Ask the engine directly instead.
    const alive = await chrome.runtime.sendMessage({ type: 'engineStatus' }).catch(() => undefined)
    if (alive?.state) return
    if (offscreenReady) return withTimeout(offscreenReady)
  }
  offscreenReady = new Promise(r => (resolveOffscreenReady = r))
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the TeX engine (WebAssembly) that compiles Overleaf projects locally.',
    })
  }
  return withTimeout(offscreenReady)
}

async function withTimeout(p: Promise<void>): Promise<void> {
  const ms = mergeSettings(await getStored('settings')).engineStartTimeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the engine didn't start within ${ms / 1000} s`)), ms) })
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

async function engineConfigForOffscreen() {
  const settings = mergeSettings(await getStored('settings'))
  return {
    idleMinutes: settings.engineIdleMinutes,
    ctanMirror: settings.ctanMirror,
    basePath: chrome.runtime.getURL('busytex').replace(/\/$/, ''),
    bundles: engineConfig.bundles,
    remoteEndpoint: settings.remoteEndpoint,
    engine: settings.engine,
  }
}

// ---- page scripts on the Overleaf origins the user enabled ----

export function matchesFor(origins: string[]): string[] {
  return origins.map(o => `${o.replace(/\/$/, '')}/project/*`)
}

async function registerScripts() {
  const origins = await getStored('origins')
  const existing = (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id)
  const stale = Object.values(SCRIPT_IDS).filter(id => existing.includes(id))
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale })
  if (!origins.length) return
  const matches = matchesFor(origins)
  await chrome.scripting.registerContentScripts([
    { id: SCRIPT_IDS.page, matches, js: ['page.js'], runAt: 'document_start', world: 'MAIN', allFrames: false },
    { id: SCRIPT_IDS.content, matches, js: ['content.js'], runAt: 'document_start', allFrames: false },
  ])
}

chrome.runtime.onInstalled.addListener(registerScripts)
chrome.runtime.onStartup.addListener(registerScripts)
chrome.storage.onChanged.addListener(changes => {
  if (STORAGE_KEYS.origins in changes) registerScripts()
})

chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove([liveKey(tabId), lastKey(tabId)]) })

// ---- compile statistics ----

let statsWrite: Promise<void> = Promise.resolve()
function recordStats(projectId: string, where: 'local' | 'server', ms: number) {
  const add = (s: CompileStats): CompileStats => ({
    ...s,
    [where]: s[where] + 1,
    [`${where}Ms`]: s[`${where}Ms`] + ms,
    lastMs: ms,
    lastWhere: where,
    lastAt: Date.now(),
  })
  statsWrite = statsWrite.then(async () => {
    const stats = await getStored('stats')
    stats.total = add({ ...EMPTY_STATS, ...stats.total })
    stats.projects[projectId] = add({ ...EMPTY_STATS, ...stats.projects[projectId] })
    await chrome.storage.local.set({ stats })
  }).catch(() => undefined)
}

// ---- messages ----

// Toolbar badge, per tab: "…" while loading the project, "TeX" while compiling here, "SRV" on the server; with settings.badgeShowsLast also where the last
// compile ran (L local, S server). The tooltip is the popup's live "Now" text. The tab's last compile (where,
// why) is kept for the popup too. Chrome clears the badge when the tab navigates; a new page starts fresh.
type Where = LastCompile['where']
const BADGE_COLORS: Record<Where | 'busy', string> = { local: '#138a36', server: '#b35c00', busy: '#5f665f' }
const BADGE_TEXT: Record<Where, string> = { local: 'L', server: 'S' }
/** What the badge shows while the tab is busy: loading the project, compiling here, compiling on the server. */
const BUSY_BADGE: Partial<Record<LiveState, { text: string; color: string }>> = {
  loading: { text: '…', color: BADGE_COLORS.busy },
  compiling: { text: 'TeX', color: BADGE_COLORS.local },
  server: { text: 'SRV', color: BADGE_COLORS.server },
}
let badgeQueue: Promise<unknown> = Promise.resolve()
const mergeSettingsStored = async () => mergeSettings(await getStored('settings'))
// switching badgeShowsLast redraws the open tabs' badges
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return
  chrome.storage.session.get(null).then(all => Object.keys(all).forEach(k => {
    const m = k.match(/^live:(\d+)$/)
    if (m) updateBadge(Number(m[1]), {})
  }))
})

/** Records what the tab reported, then redraws its badge (one at a time, so writes and reads keep their order). */
function updateBadge(tabId: number, change: { live?: { state: LiveState; text: string }; last?: LastCompile | null }) {
  badgeQueue = badgeQueue.then(async () => {
    const writes: Record<string, unknown> = {}
    if (change.live) writes[liveKey(tabId)] = { ...change.live, at: Date.now() }
    if (change.last !== undefined) writes[lastKey(tabId)] = change.last
    await chrome.storage.session.set(writes)
    const got = await chrome.storage.session.get([liveKey(tabId), lastKey(tabId)])
    const live = got[liveKey(tabId)] as { state: LiveState; text: string } | undefined
    const last = (await mergeSettingsStored()).badgeShowsLast ? (got[lastKey(tabId)] as LastCompile | null | undefined)?.where : undefined
    const busy = live ? BUSY_BADGE[live.state] : undefined
    const text = busy ? busy.text : last ? BADGE_TEXT[last] : ''
    const color = busy ? busy.color : last ? BADGE_COLORS[last] : BADGE_COLORS.busy
    await chrome.action.setBadgeText({ tabId, text })
    await chrome.action.setBadgeBackgroundColor({ tabId, color })
    await chrome.action.setTitle({ tabId, title: live ? `LocaLeaf: ${live.text}` : 'LocaLeaf' })
  }).catch(() => undefined) // the tab may be gone
}

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse) => {
  switch (msg.type) {
    case 'ensureEngine':
      ensureEngine().then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String(e) }))
      return true
    case 'closeEngine':
      offscreenReady = null
      chrome.offscreen.closeDocument().catch(() => undefined)
      sendResponse({ ok: true })
      return false
    case 'offscreenReady':
      resolveOffscreenReady?.()
      sendResponse({ ok: true })
      return false
    case 'getEngineConfig':
      engineConfigForOffscreen().then(sendResponse)
      return true
    case 'live': {
      const tabId = sender.tab?.id
      // a new page's badge doesn't carry the previous page's last compile
      if (tabId !== undefined) updateBadge(tabId, { live: { state: msg.state, text: msg.text }, ...(msg.newPage ? { last: null } : {}) })
      sendResponse({ ok: true })
      return false
    }
    case 'status': {
      if (msg.projectId && typeof msg.ms === 'number' && msg.state !== 'idle') recordStats(msg.projectId, msg.state === 'local' ? 'local' : 'server', msg.ms)
      const tabId = sender.tab?.id
      if (tabId !== undefined && msg.state !== 'idle') updateBadge(tabId, { last: { where: msg.state === 'local' ? 'local' : 'server', detail: msg.detail ?? '' } })
      sendResponse({ ok: true })
      return false
    }
  }
})
