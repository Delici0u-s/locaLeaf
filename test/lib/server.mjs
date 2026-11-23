// Tiny static file server for tests: serves files under the given roots (url prefix → directory).
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' }

export async function serve(routes) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    for (const [prefix, dir] of Object.entries(routes)) {
      if (!path.startsWith(prefix)) continue
      const file = join(dir, normalize(path.slice(prefix.length)).replace(/^(\.\.[/\\])+/, ''))
      if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) break
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size })
      createReadStream(file).pipe(res)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
