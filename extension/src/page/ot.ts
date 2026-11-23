// Pure document helpers for the mirror (unit-tested in test/unit).

/** ShareJS text op components as sent by Overleaf: insert, delete, comment (no text change). */
export type TextOpComponent = { p: number; i: string } | { p: number; d: string } | { p: number; c: string; t?: string }

/** Applies a sharejs-text-ot op. Throws if a delete doesn't match the text (the mirror then resyncs). */
export function applyTextOp(text: string, op: TextOpComponent[]): string {
  for (const c of op) {
    if ('i' in c) text = text.slice(0, c.p) + c.i + text.slice(c.p)
    else if ('d' in c) {
      if (text.slice(c.p, c.p + c.d.length) !== c.d) throw new Error(`delete mismatch at ${c.p}`)
      text = text.slice(0, c.p) + text.slice(c.p + c.d.length)
    }
  }
  return text
}

/** Overleaf sends sharejs doc lines as "binary strings" (UTF-8 bytes in UTF-16 code units). */
export function decodeLine(line: string): string {
  const bytes = new Uint8Array(line.length)
  for (let i = 0; i < line.length; i++) bytes[i] = line.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** history-ot docs arrive as raw StringFileData; tracked deletions aren't part of what gets compiled. */
export function historyOtText(raw: { content: string; trackedChanges?: { range: { pos: number; length: number }; tracking: { type: string } }[] }): string {
  const deletes = (raw.trackedChanges ?? []).filter(t => t.tracking?.type === 'delete').map(t => t.range).sort((a, b) => b.pos - a.pos)
  let text = raw.content
  for (const r of deletes) text = text.slice(0, r.pos) + text.slice(r.pos + r.length)
  return text
}
