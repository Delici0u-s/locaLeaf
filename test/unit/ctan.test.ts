import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kpseFormat, readTar } from '../../extension/src/engine/ctan'

/** Minimal tar writer for the test: ustar headers, optional GNU long-name record. */
function tar(entries: { path: string; data: string; longName?: boolean }[]): Uint8Array {
  const enc = new TextEncoder()
  const blocks: Uint8Array[] = []
  const header = (name: string, size: number, type: string) => {
    const h = new Uint8Array(512)
    h.set(enc.encode(name.slice(0, 100)), 0)
    h.set(enc.encode(size.toString(8).padStart(11, '0') + '\0'), 124)
    h[156] = type.charCodeAt(0)
    h.set(enc.encode('ustar\0'), 257)
    return h
  }
  const body = (bytes: Uint8Array) => {
    const b = new Uint8Array(Math.ceil(bytes.length / 512) * 512)
    b.set(bytes)
    return b
  }
  for (const e of entries) {
    const data = enc.encode(e.data)
    if (e.longName) {
      const name = enc.encode(e.path + '\0')
      blocks.push(header('././@LongLink', name.length, 'L'), body(name))
    }
    blocks.push(header(e.longName ? 'truncated' : e.path, data.length, '0'), body(data))
  }
  blocks.push(new Uint8Array(1024))
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0))
  let o = 0
  for (const b of blocks) { out.set(b, o); o += b.length }
  return out
}

test('reads files from a tar archive, including GNU long names', () => {
  const long = 'tex/latex/' + 'x'.repeat(120) + '/deep.sty'
  const entries = readTar(tar([
    { path: 'tex/latex/gradbars/gradbars.sty', data: '\\ProvidesPackage{gradbars}' },
    { path: long, data: 'long', longName: true },
  ]))
  assert.deepEqual(entries.map(e => e.path), ['tex/latex/gradbars/gradbars.sty', long])
  assert.equal(new TextDecoder().decode(entries[0].bytes), '\\ProvidesPackage{gradbars}')
})

test('kpathsea formats by extension', () => {
  assert.equal(kpseFormat('gradbars.sty'), 26)
  assert.equal(kpseFormat('SourceSans3-Regular.otf'), 47)
  assert.equal(kpseFormat('ec-lmr10.tfm'), 3)
  assert.equal(kpseFormat('plain.bst'), 7)
})
