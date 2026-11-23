// Messages between the page shim (MAIN world), the content script, the background and the offscreen engine.
import type { CompileOptions, CompileResult } from '../engine/protocol'
import type { WireContent } from './bytes'
import type { ProjectMode, Settings } from './settings'

/** Files to bring the engine's copy of a project up to date. */
export interface SyncPayload {
  reset: boolean
  writes: { path: string; content: string | Uint8Array }[]
  deletes: string[]
}

// ---- page ⇄ content script (window.postMessage, structured clone) ----
export const PAGE_CHANNEL = 'olr-page-to-ext'
export const EXT_CHANNEL = 'olr-ext-to-page'

export type PageRequest =
  | { type: 'hello'; projectId: string }
  | { type: 'compile'; projectId: string; clientId: string; sync: SyncPayload; options: CompileOptions; expectEpoch: number | null }
  | { type: 'stop' }
  | { type: 'clear'; projectId: string }
  | { type: 'status'; state: 'local' | 'fallback' | 'idle'; detail?: string; projectId?: string; ms?: number; cached?: boolean }

export interface HelloReply {
  settings: Settings
  mode: ProjectMode
  /** TeX Live release of the local engine. */
  texliveYear: number
}

export type CompileReply =
  | { kind: 'done'; epoch: number; result: CompileResult }
  | { kind: 'epochMismatch'; epoch: number }

// ---- content script ⇄ offscreen (runtime port, JSON) ----
export const ENGINE_PORT = 'olr-engine'

export type WireSync = { reset: boolean; writes: { path: string; content: WireContent }[]; deletes: string[] }

export type EngineRequest =
  | { type: 'sync'; projectId: string; clientId: string; sync: WireSync; expectEpoch: number | null }
  | { type: 'compile'; projectId: string; options: CompileOptions }
  | { type: 'stop' }
  | { type: 'clear'; projectId: string }

export type WireCompileResult = Omit<CompileResult, 'files'> & { files: Record<string, string> }

export type EngineReply =
  | { kind: 'synced'; epoch: number }
  | { kind: 'epochMismatch'; epoch: number }
  | { kind: 'compiled'; epoch: number; result: WireCompileResult }
  | { kind: 'ok' }

// ---- runtime messages to the background ----
export type BackgroundRequest =
  | { type: 'ensureEngine' }
  | { type: 'offscreenReady' }
  | { type: 'closeEngine' }
  | { type: 'getEngineConfig' }
  | { type: 'status'; state: 'local' | 'fallback' | 'idle'; detail?: string; projectId?: string; ms?: number; cached?: boolean }
  | { type: 'engineStatus' }
