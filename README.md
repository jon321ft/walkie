# walkie

Push-to-talk for a group. Enter a **username**, see everyone online,
pick **who hears you** — everyone, one person, or a hand-picked few — and
hold to talk. Audio flows peer-to-peer over WebRTC.

## How it works

1. `npm start` (repo root) runs a tiny signaling server on
   [http://localhost:8787](http://localhost:8787) — open it in a browser.
2. Type your name. That's the whole sign-up.
3. Everyone online appears in your list.
4. Tap **Everyone** or select specific people (you can change targets
   mid-transmission).
5. **Hold the mic to talk.** Release to stop.

No accounts, no channels to create, no database. The server only knows
names and relays connection handshakes — **audio goes device-to-device**.

## Run

```
npm install        # once (repo root — installs the `ws` dependency)
npm start          # signaling + static server on :8787
```

Web app dev workflow:

```
cd apps/web
npm install
npm run dev        # Vite dev server; /ws is proxied to :8787
npm run build      # production bundle → apps/web/dist (served by npm start)
```

## Architecture

```
Browser A ──offer/answer/ICE──> signaling server ──relay──> Browser B
    │                                                            │
    └────────────────── audio: direct WebRTC (DTLS-SRTP) ────────┘
```

- **Full mesh**: one `RTCPeerConnection` per pair; 4 people = 3 peers each.
- **Deterministic roles**: the peer with the lower id always initiates the
  offer; the other answers. No renegotiation after connect — ever.
- **PTT** = enable/disable of one mic track; selective targeting is
  receiver-side (listeners unmute only peers transmitting to them).
- **Robust to**: autoplay blocks (gesture unlock), server blips (auto
  reconnect with backoff + name takeover), stale peers (roster sync).

Key files: [apps/web/src/mesh.ts](apps/web/src/mesh.ts) (WebRTC engine),
[apps/web/src/App.tsx](apps/web/src/App.tsx) (UI), [server/ws.mjs](server/ws.mjs)
(signaling).

## Verified end-to-end (2026-09-30)

Two browser tabs, isolated server: connect ✓ → hold PTT → receiver audio
element **playing with advancing currentTime** (real RTP) ✓ → switch
target mid-transmission → receiver gate mutes/unmutes instantly ✓ →
release → clean CONNECTED ✓. Debug ring buffer: `window.__meshDebug` in
the console.

## Design

- Background `#F4F6FA`, surface `#F9FAFC`, text `#202936`
- Mic accent `#F0444D`, active green `#35A66F`, waveform `#536B80`
- Soft neumorphism, Inter font, no gradients, no glassmorphism

## Notes & limits

- **Windows Smart App Control**: blocks unsigned native binaries; rollup is
  swapped to its WASM build via `overrides` in `apps/web/package.json` —
  do not remove.
- STUN-only traversal: works on typical home/office networks; symmetric-NAT
  (some corporate/hotspot networks) needs a TURN relay — deliberately
  excluded (it's a server).
- Mic permission: the browser prompts on first join; denying shows an
  error card.
- Everyone talks directly to everyone — best for small groups (2–6).
  Larger groups would need an SFU (LiveKit), kept in `/plans` as a future path.
