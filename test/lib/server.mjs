// Tiny static file server for tests: serves files under the given roots (url prefix → directory), or
// proxies a prefix to a remote base URL when the route is { proxy: 'https://…' } (with an on-disk cache).
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' }

export async function serve(routes) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    for (const [prefix, dir] of Object.entries(routes)) {
      if (!path.startsWith(prefix)) continue
      if (typeof dir === 'object') { proxy(dir, path.slice(prefix.length), res); return }
      const file = join(dir, normalize(path.slice(prefix.length)).replace(/^(\.\.[/\\])+/, ''))
      if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) break
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size })
      createReadStream(file).pipe(res)
      return
    }
    res.writeHead(404).end()
  })
  async function proxy({ proxy: base, cacheDir }, rest, res) {
    const url = `${base.replace(/\/$/, '')}/${rest}`
    const file = cacheDir && join(cacheDir, createHash('sha1').update(url).digest('hex'))
    try {
      let body = file && existsSync(file) ? readFileSync(file) : null
      if (!body) {
        const r = await fetch(url)
        if (!r.ok) { res.writeHead(r.status).end(); return }
        body = Buffer.from(await r.arrayBuffer())
        if (file) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, body) }
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
      res.end(body)
    } catch (e) {
      res.writeHead(502).end(String(e))
    }
  }
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
