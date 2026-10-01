/**
 * walkie signaling server — deliberately tiny.
 *
 * It does ONLY:
 *   1. presence: who is online, keyed by a username
 *   2. handshake relay: forwards WebRTC offer/answer/ICE between peers
 *   3. static hosting of apps/web/dist (production)
 *
 * Audio never touches this server — it flows peer-to-peer over WebRTC.
 * Run:  node server/ws.mjs   (or `npm start` from the walkie-app root)
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'apps', 'web', 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, clients: clients.size }))
    return
  }
  const NO_STORE = { 'cache-control': 'no-store' }
  try {
    const rel = url.pathname === '/' ? '/index.html' : url.pathname
    const file = normalize(join(DIST, rel))
    if (!file.startsWith(DIST)) throw new Error('traversal')
    const body = await readFile(file)
    const immutable = rel.startsWith('/assets/') // hashed filenames
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    })
    res.end(body)
  } catch {
    // SPA fallback
    try {
      const body = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...NO_STORE })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('build missing — run: cd apps/web && npm run build')
    }
  }
})

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

/** ws → { id, name } */
const clients = new Map()
let nextId = 1

const PROTOCOL_VERSION = 6 // bump when the client build changes materially

function roster() {
  return [...clients.values()].map(({ id, name }) => ({ id, name }))
}

function broadcastRoster() {
  const msg = JSON.stringify({ t: 'roster', users: roster(), v: PROTOCOL_VERSION })
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(msg)
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.t === 'hello') {
      const name = String(msg.name ?? '').trim().slice(0, 24)
      if (!name) {
        ws.send(JSON.stringify({ t: 'error', code: 'bad-name', message: 'Pick a name first.' }))
        return
      }
      // takeover: a reconnecting client with the same name replaces the dead slot
      for (const [oldWs, oldMe] of clients) {
        if (oldMe.name.toLowerCase() === name.toLowerCase()) {
          clients.delete(oldWs)
          try {
            // tell the displaced client why, so it stops fighting for the name
            oldWs.send(
              JSON.stringify({
                t: 'error',
                code: 'taken',
                message: 'This name signed in from another tab or device.',
              }),
            )
          } catch {
            /* gone */
          }
          try {
            oldWs.terminate()
          } catch {
            /* gone */
          }
          broadcastRoster()
        }
      }
      const me = { id: 'u' + nextId++, name }
      clients.set(ws, me)
      const others = roster().filter((u) => u.id !== me.id)
      ws.send(JSON.stringify({ t: 'welcome', ...me, users: others, v: PROTOCOL_VERSION }))
      broadcastRoster()
      console.log(`[walkie] ${name} (${me.id}) joined — ${clients.size} online`)
      return
    }

    const me = clients.get(ws)
    if (!me) return

    if (msg.t === 'offer' || msg.t === 'answer' || msg.t === 'cand') {
      for (const [peer, info] of clients) {
        if (info.id === msg.to) {
          peer.send(JSON.stringify({ t: msg.t, from: me.id, fromName: me.name, ...stripTo(msg) }))
          return
        }
      }
      return
    }

    if (msg.t === 'leave') {
      ws.close()
    }
  })

  ws.on('close', () => {
    const me = clients.get(ws)
    clients.delete(ws)
    if (me) {
      broadcastRoster()
      console.log(`[walkie] ${me.name} left — ${clients.size} online`)
    }
  })
})

function stripTo({ t, sdp, candidate }) {
  return t === 'cand' ? { candidate } : { sdp }
}

// heartbeat: drop dead sockets quickly so the roster stays honest
setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 15000)

httpServer.listen(PORT, () => {
  console.log(`[walkie] signaling + static server on http://localhost:${PORT}`)
})
