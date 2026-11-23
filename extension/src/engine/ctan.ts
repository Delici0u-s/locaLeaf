// TeX Live packages straight from a CTAN mirror (tlnet/archive/<pkg>.tar.xz), for files the bundle and the
// package server don't have. Archives are cached in the extension's IndexedDB.
import { XzReadableStream } from 'xz-decompress'

/** kpathsea file formats by extension (kpse_file_format_type), for registering fetched files. */
const FORMATS: Record<string, number> = {
  tfm: 3, afm: 4, bib: 6, bst: 7, map: 11, pfb: 32, pfa: 32, vf: 33, ttf: 36, ttc: 36, enc: 44, otf: 47, lua: 51,
}
const TEX = 26 // sty, cls, def, cfg, clo, fd, tex, ldf, … (everything \input finds)

export function kpseFormat(name: string): number {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return FORMATS[ext] ?? TEX
}

export interface TarEntry { path: string; bytes: Uint8Array }

/** Regular files of a tar archive (ustar, GNU long names, pax path records). */
export function readTar(tar: Uint8Array): TarEntry[] {
  const out: TarEntry[] = []
  const dec = new TextDecoder()
  const str = (o: number, n: number) => { const s = dec.decode(tar.subarray(o, o + n)); const z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z) }
  let pos = 0
  let longName: string | null = null
  while (pos + 512 <= tar.length) {
    if (tar[pos] === 0) break // end-of-archive blocks
    const size = parseInt(str(pos + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(tar[pos + 156] || 48)
    const prefix = str(pos + 345, 155)
    const data = tar.subarray(pos + 512, pos + 512 + size)
    let name = longName ?? (prefix ? `${prefix}/${str(pos, 100)}` : str(pos, 100))
    longName = null
    if (type === 'L') longName = dec.decode(data).replace(/\0.*$/s, '')
    else if (type === 'x') {
      const m = dec.decode(data).match(/\d+ path=([^\n]*)\n/)
      if (m) longName = m[1]
    } else if (type === '0' || type === '\0' || type === '7') out.push({ path: name, bytes: data.slice() })
    pos += 512 + Math.ceil(size / 512) * 512
    name = ''
  }
  return out
}

export async function unxz(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new XzReadableStream(new Blob([bytes as BlobPart]).stream())
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Runtime files of a TeX Live package (archive paths are relative to texmf-dist), downloaded once and cached. */
export async function packageFiles(mirror: string, pkg: string, cache: (key: string, load: () => Promise<ArrayBuffer | null>) => Promise<ArrayBuffer | null>): Promise<TarEntry[]> {
  const url = `${mirror.replace(/\/$/, '')}/systems/texlive/tlnet/archive/${encodeURIComponent(pkg)}.tar.xz`
  const xz = await cache(`ctan:${url}`, async () => {
    const res = await fetch(url)
    return res.ok ? res.arrayBuffer() : null
  })
  if (!xz) return []
  return readTar(await unxz(new Uint8Array(xz))).filter(e => !e.path.startsWith('tlpkg/'))
}
