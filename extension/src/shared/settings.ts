// User settings: defaults from config/settings.defaults.json, overrides in chrome.storage.local.
import defaults from '../../../config/settings.defaults.json'
import type { EngineSettings } from '../engine/protocol'

export interface Settings {
  remoteEndpoint: string
  engine: EngineSettings
  keepBuilds: number
  barrierTimeoutMs: number
  joinConcurrency: number
  fallbackToServer: boolean
  maxSyncChunkBytes: number
  fetchConcurrency: number
  historyOtRefetchMs: number
  toastMs: number
  engineIdleMinutes: number
  serverOnMissingFonts: boolean
  joinRetries: number
  joinRetryDelayMs: number
  joinTimeoutMs: number
  maxRetryAfterMs: number
  serverOnMissingPackages: boolean
  serverOnShellEscape: boolean
  ctanMirror: string
  localTimeoutSeconds: number
  statusDelayMs: number
  statusPosition: StatusPosition
  statusFallbackPosition: StatusPosition
  statusX: number
  statusY: number
  liveUpdateMs: number
  previewMs: number
}

export type StatusPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'toolbar' | 'custom'

export type ProjectMode = 'local' | 'server'

export const DEFAULT_SETTINGS: Settings = stripComments(defaults) as Settings

export function mergeSettings(overrides: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides, engine: { ...DEFAULT_SETTINGS.engine, ...overrides?.engine } }
}

/** Keys starting with "$" are documentation in the JSON file. */
function stripComments(v: any): any {
  if (Array.isArray(v)) return v.map(stripComments)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('$')).map(([k, x]) => [k, stripComments(x)]))
  return v
}

export const STORAGE_KEYS = {
  settings: 'settings',
  origins: 'origins',
  projectModes: 'projectModes',
  stats: 'stats',
} as const

/** Compile counts and times (ms), per project and overall. */
export interface CompileStats {
  local: number
  server: number
  localMs: number
  serverMs: number
  lastMs: number
  lastWhere: 'local' | 'server' | null
  lastAt: number
}

export const EMPTY_STATS: CompileStats = { local: 0, server: 0, localMs: 0, serverMs: 0, lastMs: 0, lastWhere: null, lastAt: 0 }

export interface Stored {
  settings: Partial<Settings>
  origins: string[]
  projectModes: Record<string, ProjectMode>
  stats: { total: CompileStats; projects: Record<string, CompileStats> }
}

const STORED_DEFAULTS: Stored = { settings: {}, origins: [], projectModes: {}, stats: { total: { ...EMPTY_STATS }, projects: {} } }

/** Typed read of one chrome.storage.local key. */
export async function getStored<K extends keyof Stored>(key: K): Promise<Stored[K]> {
  const r = await chrome.storage.local.get(key)
  return (r[key] as Stored[K] | undefined) ?? STORED_DEFAULTS[key]
}
