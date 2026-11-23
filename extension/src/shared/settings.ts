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
  maxRetryAfterMs: number
}

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
} as const

export interface Stored {
  settings: Partial<Settings>
  origins: string[]
  projectModes: Record<string, ProjectMode>
}

const STORED_DEFAULTS: Stored = { settings: {}, origins: [], projectModes: {} }

/** Typed read of one chrome.storage.local key. */
export async function getStored<K extends keyof Stored>(key: K): Promise<Stored[K]> {
  const r = await chrome.storage.local.get(key)
  return (r[key] as Stored[K] | undefined) ?? STORED_DEFAULTS[key]
}
