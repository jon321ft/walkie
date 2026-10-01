# Blueprint: Church Walkie-Talkie PTT App (Web + Android APK)

**Status:** SHIPPED 2026-09-30 — username-only mesh with selective targeting (see "P2P pivot" and "v0.3 rework" below). S2–S10 obsolete for v1.
**Mode:** Direct mode (no git remote yet; `git init` in Step 1)
**Created:** 2026-09-28 · **Updated:** 2026-09-30

## Objective

Build a professional push-to-talk communication app for a church media team:
a web app and a native Android APK sharing one backend. Live voice via WebRTC
(LiveKit Cloud), data/auth/storage via Supabase.

## v0.3 rework (2026-09-30, "why is there no audio")

User asks: username-only entry (no channels), talk to one / several / all
simultaneously. Forensic debugging of the "no audio" reports found and fixed:

1. **Muted-mic never unmuted** — mesh rewrite dropped the `track.enabled =
   true` on PTT; transmitters sent perfect silence. PTT now toggles the
   single stable mic track.
2. **Empty `e.streams` discarded every remote track** — `addTransceiver`
   delivers ontrack without a stream; code bailed and never played audio.
   Now wraps `e.track` idempotently.
3. **Transceiver misalignment** — pre-created sendrecv transceivers +
   implicit negotiation produced mid=null m-lines and no RTP. Fixed with
   the canonical pattern: initiator `addTrack`s before offering; answerer
   attaches its mic to the offer-created transceiver.
4. **Test-harness bug**: App.tsx hardcoded `ws://host:8787` so every
   "isolated" test server actually shared one room with stale old-build
   tabs. Now same-origin (`/ws`), Vite-proxied in dev.

Final v3 design (`apps/web/src/mesh.ts`): one stable mic track, PTT =
enabled toggle, no renegotiation ever, deterministic initiator (lower id),
receiver-side audience gating, auto-reconnect with name takeover, gesture
audio unlock. Verified end-to-end incl. live retargeting mid-transmission.

## P2P pivot (2026-09-30)

User direction: **remove all fake users and communicate via WebRTC**. v1 is
now serverless:

- All mock users/channels/fixtures deleted from the UI
- `apps/web/src/webrtc.ts` — `useWalkieP2P` hook: `RTCPeerConnection` audio
  track + DataChannel speaking-signals, Google STUN, manual copy-paste
  invite codes (offer `WT1:…` → answer `WT1:…`)
- Connect screen (Host/Join) + connected talk screen with live
  Transmitting/Receiving states driven by real audio meters (WebAudio RMS)
- E2E verified in-browser: two tabs exchanged codes, connected (~26 s ICE on
  this machine — mDNS candidate resolution is slow here), host PTT → guest
  RECEIVING via DataChannel, clean release
- LiveKit/Supabase remain an option for channels-with-many-people later;
  the old migration in `/supabase` is kept but unused

## Original locked decisions (pre-pivot, for reference)

| Decision | Choice | Rationale |
|---|---|---|
| Voice delivery | Live WebRTC streaming via **LiveKit Cloud** (free tier) | User chose live streaming; Supabase cannot fan out media — LiveKit is the SFU. Kotlin + JS SDKs are first-class. |
| Android | **Native Kotlin + Jetpack Compose** | Best mic/background-service/Bluetooth control for PTT |
| Web | **React + Vite + TypeScript + Tailwind** | Fast, designer-friendly |
| Backend | **Supabase** (Auth, Postgres, RLS, Storage, Edge Functions) | User choice; covers everything except media |
| Voice history | Speaker's client records its own transmission clip and uploads to Supabase Storage on release; row inserted into `transmissions` | Dual path: live via LiveKit, persistence via upload. No egress infra needed for MVP. |
| v1 scope | Lean MVP: PTT, channels, live speaker indicator + waveform, voice history, auth/presence. **Deferred:** private PTT, Bluetooth routing UI, advanced audio settings, iOS | User choice |

## Design Language (from user's spec — binding for all UI work)

- Background `#F4F6FA`, surface `#F9FAFC`, text `#202936`, secondary `#8B94A3`
- Icons `#60758C`, mic accent `#F0444D`, active green `#35A66F`, waveform `#536B80`
- Soft neumorphism, restrained shadows, Inter font, generous spacing
- Anti-slop rules: no gradients, no glassmorphism, no blobs, no oversized type

## File Structure (actual, as of 2026-09-30)

```
walkie-app/
/apps/web        Vite 6 + React 18 + TS 5.6 + Tailwind v4 (@tailwindcss/vite)
  └ src/         App.tsx (Talk screen, typed, 5 PTT states), main.tsx, index.css (@theme tokens)
/apps/android    Placeholder for Kotlin/Jetpack Compose (S8)
/supabase        config.toml + migrations/0001_init.sql (schema + RLS, not yet pushed)
/plans           This blueprint
README.md, .gitignore, .env.example
```

Note: stack uses **Tailwind v4** (CSS-first `@theme`, no tailwind.config.js) and
**no router yet** — single Talk screen; router arrives with S6.
Supabase deps (@supabase/supabase-js) install with S2/S3 wiring.

## Next Steps for Local Setup

1. **Install prerequisites on your machine:**
   - Node.js LTS (from [nodejs.org](https://nodejs.org))
   - Git (from [git-scm.com](https://git-scm.com))
   - Supabase CLI (run `npm install -g supabase`)

2. **Run the setup commands:**
   ```bash
   # From your project root:
   cd walkie-app
   cd apps/web
   npm install
   npm run dev
   # (In another terminal)
   cd ../supabase
   supabase start
   ```

3. **Access your app:**
   - Web: http://localhost:5173
   - Supabase Studio: http://local.supabase.com:54323

## What You'll See Locally (verified 2026-09-30)

The walkie app in **demo mode** (mock people/channels, no network):
- Clean UI matching your exact color palette, neumorphic surfaces
- PTT home screen: 156px coral mic button, hold-to-talk (pointer events, mobile-safe)
- Channel header + channel switcher pills (Main Team / Media)
- User card for "Colleen Watson" with tappable availability cycler
- Speaker card + 24-bar animated waveform while transmitting/receiving
- Status pill: OFFLINE / READY / LISTENING / TRANSMITTING / RECEIVING
- Bottom navigation (Talk active; Channels/History/Profile arrive with S6)
- Dev-only demo buttons: simulate incoming speaker, go offline/online
- All five UI states tested live; build green (tsc strict + vite build)

## Environment Note: Smart App Control

This machine runs Windows **Smart App Control (ON)** — it blocks unsigned
native `.node` binaries, which killed rollup (dev + build). Fixed via npm
overrides in `apps/web/package.json`:

```json
"overrides": { "rollup": "npm:@rollup/wasm-node@^4.63.5" }
```

This swaps rollup to its official WebAssembly build — no native dlopen, SAC-
safe. **Do not remove.** Any future native-binding dependency (esbuild forks,
sqlite drivers, sharp, etc.) may hit the same wall; prefer WASM builds.

## Important Design Notes

- **Design language is binding** — no gradients, glassmorphism, or blobs
- **Channel list simplified** for MVP: Main Team, Media (instead of 6 channels)
- **All admin/FCM references removed** per user request
- **App renamed to "walkie"** as requested
- **LiveKit free-tier limits noted** as open risks
- **No git remote** — direct mode for all steps

## Key Files

### Web App (`/apps/web/`)
- `package.json` — React 18, Vite 6, TS 5.6, Tailwind v4, livekit-client; SAC-safe rollup override
- `vite.config.ts` — React + Tailwind v4 Vite plugins
- `tsconfig.json` — single strict app config
- `index.html` — Inter preconnect, inline SVG favicon
- `src/index.css` — Tailwind v4 `@theme` tokens (exact design palette), anti-slop rules
- `src/App.tsx` — Talk screen: typed domain models, mock fixtures (marked for S5 swap),
  MicButton / Waveform / SpeakerArea / StatusPill / YouCard / ChannelHeader / BottomNav
- `src/main.tsx` — plain ReactDOM mount (router deferred to S6)

### Supabase (`/supabase/`)
- `config.toml` — local stack config (project_id placeholder)
- `migrations/0001_init.sql` — profiles / channels / channel_members / transmissions + RLS (not yet applied anywhere)

All files respect the **anti-slop design constraints** and exact **color palette** from the user's spec.

## 🔧 Local Setup Steps

1. Run `npm install` in `walkie-app/apps/web` (deps already installed here)
2. Run `npm run dev` in `walkie-app/apps/web` → http://localhost:5173
3. Production build: `npm run build` (passes; SAC-safe via WASM rollup)

## 📱 Next Steps (backend wiring — accounts needed)

1. Create Supabase project (free tier) → put URL + anon key in `apps/web/.env.local`
2. Create LiveKit Cloud project (free tier) → URL + key + secret for the Edge Function
3. S2: `supabase db push` the migration, create private `clips` bucket + policies
4. S3: write `livekit-token` Edge Function (Deno, livekit-server-sdk)
5. S5: swap mock fixtures for Supabase queries + LiveKit room wiring (seams already marked in App.tsx)

**All admin/FCM references removed** ✅
**App renamed to "walkie"** ✅
**Channels simplified for MVP** ✅
**Web demo-mode MVP running** ✅