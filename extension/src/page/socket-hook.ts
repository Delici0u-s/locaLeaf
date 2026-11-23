// Captures Overleaf's socket.io global and the editor's own socket.
// socket.io.js runs `var io = {}` and attaches `io.connect` afterwards, so we catch the global assignment
// (accessor on window) and then the `connect` assignment on that object.

export interface IoSocket {
  on(event: string, fn: (...args: any[]) => void): void
  removeListener(event: string, fn: (...args: any[]) => void): void
  emit(event: string, ...args: any[]): void
  disconnect(): void
  socket?: { connected?: boolean; disconnect(): void }
}

export interface Io {
  connect(url: string, opts: Record<string, unknown>): IoSocket
}

type Listener = (io: Io) => void
type SocketListener = (s: IoSocket) => void

let io: Io | null = null
let ownConnect = false
const ioListeners: Listener[] = []
const editorSocketListeners: SocketListener[] = []

export function installSocketHook() {
  let value: any = (window as any).io
  if (value) adopt(value)
  Object.defineProperty(window, 'io', {
    configurable: true,
    get: () => value,
    set: v => {
      value = v
      adopt(v)
    },
  })
}

function adopt(obj: any) {
  if (!obj || typeof obj !== 'object') return
  let connect = obj.connect
  const wrapped = function (this: unknown, ...args: any[]) {
    const socket = connect.apply(this, args)
    if (!ownConnect) for (const l of editorSocketListeners) l(socket)
    return socket
  }
  Object.defineProperty(obj, 'connect', {
    configurable: true,
    get: () => (connect ? wrapped : undefined),
    set: f => {
      connect = f
      if (f) announce(obj)
    },
  })
  if (connect) announce(obj)
}

function announce(obj: any) {
  if (io === obj) return
  io = obj
  for (const l of ioListeners.splice(0)) l(obj)
}

/** Resolves once socket.io has loaded. */
export function whenIo(): Promise<Io> {
  return io ? Promise.resolve(io) : new Promise(r => ioListeners.push(r))
}

/** Called for each socket the Overleaf editor opens (not ours). */
export function onEditorSocket(fn: SocketListener) {
  editorSocketListeners.push(fn)
}

/** Opens a socket that the editor-socket listeners don't see. */
export function connectOwn(url: string, opts: Record<string, unknown>): IoSocket {
  ownConnect = true
  try {
    return io!.connect(url, opts)
  } finally {
    ownConnect = false
  }
}
