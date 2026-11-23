// Messages between the offscreen document and the engine worker.

export type Compiler = 'pdflatex' | 'xelatex' | 'lualatex'

export interface EngineSettings {
  /** Upper bound on TeX passes per compile (latexmk's default is 5). */
  maxPasses: number
  /** File extensions whose change triggers another TeX pass. */
  rerunExtensions: string[]
  /** Extra biber arguments (e.g. --output-safechars). */
  biberArgs: string[]
  /** Generated files returned to the page besides output.pdf/log/synctex. */
  outputExtensions: string[]
  /** Projects kept in memory between compiles (LRU). */
  maxProjects: number
  /** Fetch fonts that fontspec asks for by name (see config/font-index.json). */
  fetchMissingFonts: boolean
}

export interface InitMessage {
  type: 'init'
  basePath: string
  bundles: string[]
  remoteEndpoint: string
  /** URL of config/font-index.json in the extension. */
  fontIndexUrl: string
  settings: EngineSettings
}

export interface FileWrite {
  path: string
  content: string | Uint8Array
}

export interface SyncMessage {
  type: 'sync'
  projectId: string
  writes: FileWrite[]
  deletes: string[]
  /** The writes are the complete source list: sources not in it are deleted (generated files stay). */
  reset: boolean
}

export interface CompileOptions {
  main: string
  compiler: Compiler
  draft: boolean
  stopOnFirstError: boolean
}

export interface CompileMessage extends CompileOptions {
  type: 'compile'
  id: number
  projectId: string
}

export interface ClearMessage {
  type: 'clear'
  projectId: string
}

export type ToWorker = InitMessage | SyncMessage | CompileMessage | ClearMessage

export type CompileStatus = 'success' | 'failure' | 'stopped-on-first-error' | 'error'

export interface CompileResult {
  status: CompileStatus
  /** Output files by name relative to the output dir (output.pdf, output.log, …). */
  files: Record<string, Uint8Array>
  passes: string[]
  errors: number
  ms: number
  /** True when nothing changed since the last compile and its result was reused. */
  cached: boolean
  /** Directory of the main file inside the project (synctex paths are relative to it). */
  outputDir: string
  /** Absolute path of the project in the engine's file system (synctex records absolute paths under it). */
  projectRoot: string
  /** Fonts fontspec asked for that couldn't be provided (the PDF would use the wrong font). */
  missingFonts: string[]
  /** TeX Live files the document needs that the engine couldn't get (the PDF would be incomplete). */
  missingPackages: string[]
  message?: string
}

export type FromWorker =
  | { type: 'ready'; versions: Record<string, string> }
  | { type: 'synced'; projectId: string; needReset: boolean }
  | { type: 'compiled'; id: number; result: CompileResult }
  | { type: 'cleared'; projectId: string }
  | { type: 'print'; text: string }
  | { type: 'error'; id?: number; message: string }
