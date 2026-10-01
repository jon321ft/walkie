import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useWalkieMesh, unlockWalkieAudio, walkieSelfTest, walkieMicTest, BUILD_VERSION, type PeerInfo } from './mesh'

/**
 * Walkie — username in, pick who hears you, hold to talk.
 * Audio is peer-to-peer (WebRTC); the tiny server only knows names.
 */

// same origin as the page: the walkie server serves HTTP+WS on its port,
// and in dev the Vite proxy forwards /ws to the signaling server
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

// ---------------------------------------------------------------------------
// Design tokens — mirror of src/index.css @theme (binding design language)
// ---------------------------------------------------------------------------
const T = {
  background: '#F4F6FA',
  surface: '#F9FAFC',
  ink: '#202936',
  inkSecondary: '#8B94A3',
  icon: '#60758C',
  mic: '#F0444D',
  active: '#35A66F',
  waveform: '#536B80',
  border: '#E5E9EF',
  barIdle: '#C7D0DB',
} as const

const SHADOW = {
  raised: '6px 6px 14px rgba(32,41,54,0.07), -6px -6px 14px rgba(255,255,255,0.9)',
  raisedSm: '3px 3px 7px rgba(32,41,54,0.06), -3px -3px 7px rgba(255,255,255,0.9)',
  pressed: 'inset 3px 3px 7px rgba(32,41,54,0.08), inset -3px -3px 7px rgba(255,255,255,0.9)',
} as const

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function MicIcon({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Username gate
// ---------------------------------------------------------------------------
function NameGate({ connecting, error, onJoin, onDismissError }: { connecting: boolean; error: string | null; onJoin: (name: string) => void; onDismissError: () => void }) {
  const [name, setName] = useState('')
  const submit = () => {
    const n = name.trim()
    if (n.length >= 2) onJoin(n)
  }
  return (
    <section className="mt-10 flex flex-col gap-5">
      <div>
        <h1 className="text-[28px] font-bold leading-tight" style={{ color: T.ink }}>
          What's your name?
        </h1>
        <p className="mt-1 text-sm font-medium" style={{ color: T.inkSecondary }}>
          That's all we need. No accounts, no channels.
        </p>
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="e.g. Marcus"
        maxLength={24}
        autoFocus
        className="w-full rounded-2xl px-5 py-4 text-[16px] font-semibold outline-none"
        style={{ background: T.surface, boxShadow: SHADOW.pressed, color: T.ink, border: `1px solid ${T.border}` }}
      />
      <button
        onClick={submit}
        disabled={name.trim().length < 2 || connecting}
        className="w-full rounded-full py-4 text-[15px] font-bold text-white transition-all disabled:opacity-40"
        style={{ background: T.mic, boxShadow: SHADOW.raisedSm }}
      >
        {connecting ? 'Connecting…' : 'Start talking'}
      </button>
      {error && (
        <button onClick={onDismissError} className="rounded-2xl px-4 py-3 text-left text-[12px] font-semibold" style={{ background: T.surface, color: T.mic, boxShadow: SHADOW.raisedSm }}>
          {error} <span style={{ color: T.inkSecondary }}>— tap to dismiss</span>
        </button>
      )}
      <p className="text-center text-[11px] font-medium" style={{ color: T.inkSecondary }}>
        Audio goes device-to-device (WebRTC). The server only sees your name.
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Person row
// ---------------------------------------------------------------------------
function PersonRow({
  peer,
  selected,
  modeAll,
  onToggle,
}: {
  peer: PeerInfo
  selected: boolean
  modeAll: boolean
  onToggle: () => void
}) {
  const dot = peer.speaking ? T.mic : peer.listening ? T.active : peer.state === 'connected' ? T.active : T.barIdle
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-all"
      style={{ background: T.surface, boxShadow: selected && !modeAll ? SHADOW.pressed : SHADOW.raisedSm }}
      aria-pressed={modeAll || selected}
    >
      <span
        className="flex h-9 w-9 items-center justify-center rounded-full text-[12px] font-bold"
        style={{ background: T.background, color: T.icon, boxShadow: SHADOW.pressed }}
      >
        {peer.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="text-[15px] font-semibold" style={{ color: T.ink }}>
        {peer.name}
      </span>
      {peer.speaking && (
        <span className="text-[11px] font-bold" style={{ color: T.mic }}>
          speaking
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {!modeAll && selected && (
          <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: T.ink, color: '#fff' }}>
            <CheckIcon />
          </span>
        )}
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: dot }} title={peer.state} />
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Waveform — driven by a live level getter
// ---------------------------------------------------------------------------
const BAR_COUNT = 24

function Waveform({ active, getLevel }: { active: boolean; getLevel: () => number }) {
  const barRefs = useRef<(HTMLSpanElement | null)[]>([])
  const getRef = useRef(getLevel)
  getRef.current = getLevel

  useEffect(() => {
    if (!active) {
      for (const el of barRefs.current) if (el) el.style.height = '15%'
      return
    }
    let raf = 0
    const loop = () => {
      const level = Math.min(1, getRef.current())
      barRefs.current.forEach((el, i) => {
        if (!el) return
        const spread = 0.55 + 0.45 * Math.abs(Math.sin(i * 0.55))
        const h = 12 + 88 * level * spread + Math.random() * 6
        el.style.height = `${Math.max(8, Math.min(100, h))}%`
      })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active])

  return (
    <div className="flex h-14 items-center justify-center gap-[5px]" aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barRefs.current[i] = el
          }}
          className="w-[5px] rounded-full"
          style={{ height: '15%', background: active ? T.waveform : T.barIdle, transition: 'height 80ms linear, background 200ms' }}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mic button
// ---------------------------------------------------------------------------
const MIC_PX = 156

function MicButton({ disabled, pressed, onStart, onEnd }: { disabled: boolean; pressed: boolean; onStart: () => void; onEnd: () => void }) {
  const handlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      e.preventDefault()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic pointer */
      }
      onStart()
    },
    onPointerUp: onEnd,
    onPointerCancel: onEnd,
    onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
  }
  const bg = pressed ? T.mic : T.surface
  const fg = pressed ? '#FFFFFF' : disabled ? T.barIdle : T.icon
  return (
    <button
      {...handlers}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={pressed ? 'Release to stop transmitting' : 'Hold to talk'}
      className="flex select-none items-center justify-center rounded-full focus:outline-none disabled:cursor-not-allowed"
      style={{
        width: MIC_PX,
        height: MIC_PX,
        background: bg,
        color: fg,
        boxShadow: pressed ? SHADOW.pressed : SHADOW.raised,
        border: `2px solid ${pressed ? T.mic : T.border}`,
        transition: 'background 120ms, box-shadow 120ms, color 120ms',
        touchAction: 'none',
      }}
    >
      <MicIcon size={52} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Probe buttons (playback path / real mic) with a shared result line
// ---------------------------------------------------------------------------
function ProbeButtons({ selfTest, micTest, engineState, rxRate, onSelfTest, onMicTest }: {
  selfTest: string | null
  micTest: string | null
  engineState: string
  rxRate: number
  onSelfTest: () => void
  onMicTest: () => void
}) {
  const line = micTest ?? selfTest
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button
        onClick={onSelfTest}
        className="rounded-full px-3 py-1.5 text-[11px] font-semibold"
        style={{ background: T.surface, color: T.icon, boxShadow: SHADOW.raisedSm }}
      >
        Test audio
      </button>
      <button
        onClick={onMicTest}
        className="rounded-full px-3 py-1.5 text-[11px] font-semibold"
        style={{ background: T.surface, color: T.icon, boxShadow: SHADOW.raisedSm }}
      >
        Test mic
      </button>
      <span className="font-mono text-[10px] font-medium" style={{ color: T.inkSecondary }} title={`engine ${engineState} · build v${BUILD_VERSION}`}>
        v{BUILD_VERSION} · {engineState} · rx {rxRate} B/s
      </span>
      {line && (
        <p className="mt-1 w-full font-mono text-[10px]" style={{ color: line.startsWith('✓') ? T.active : T.mic }}>
          {line}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const w = useWalkieMesh(WS_URL)
  const [someIds, setSomeIds] = useState<Set<string>>(new Set())
  const [selfTest, setSelfTest] = useState<string | null>(null)
  const [micTest, setMicTest] = useState<string | null>(null)
  const modeAll = w.targets.kind === 'all'

  const runSelfTest = async () => {
    setSelfTest('testing…')
    const r = await walkieSelfTest()
    setSelfTest((r.ok ? '✓ ' : '✗ ') + r.detail)
    setTimeout(() => setSelfTest(null), 10000)
  }

  const runMicTest = async () => {
    setMicTest('listening to your mic…')
    const r = await walkieMicTest()
    setMicTest((r.ok ? '✓ ' : '✗ ') + r.detail)
    setTimeout(() => setMicTest(null), 10000)
  }

  // Browsers block audio without a gesture — unlock on any interaction
  useEffect(() => {
    const onGesture = () => unlockWalkieAudio()
    window.addEventListener('pointerdown', onGesture)
    window.addEventListener('keydown', onGesture)
    return () => {
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
    }
  }, [])

  const audience = useMemo(() => {
    if (!w.me) return 0
    if (modeAll) return w.peers.filter((p) => p.state === 'connected').length
    return w.peers.filter((p) => someIds.has(p.id) && p.state === 'connected').length
  }, [modeAll, someIds, w.me, w.peers])

  const anyoneReceiving = w.peers.some((p) => p.speaking || p.listening)
  const audioActive = w.speaking || anyoneReceiving

  const getLevel = () => {
    if (w.speaking) return w.localLevelRef.current
    let max = 0
    for (const p of w.peers) max = Math.max(max, w.remoteLevelFor(p.id))
    return max
  }

  const togglePerson = (id: string) => {
    const next = new Set(someIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSomeIds(next)
    w.setTarget({ kind: 'some', ids: [...next] })
  }

  const selectAll = () => {
    setSomeIds(new Set())
    w.setTarget({ kind: 'all' })
  }

  const startTalking = () => {
    unlockWalkieAudio() // this press is also a gesture: retry any blocked playback
    void w.startTalking()
  }

  const canTalk = w.peers.length > 0 && audience > 0
  const receivingFrom = w.peers.find((p) => p.speaking || p.listening)

  return (
    <div className="min-h-dvh w-full" style={{ background: T.background, color: T.ink }}>
      <div className="mx-auto flex min-h-dvh max-w-[430px] flex-col px-5 pb-4">
        <header className="flex items-center justify-between pt-5">
          <span className="text-[13px] font-semibold tracking-wide" style={{ color: T.inkSecondary }}>
            WALKIE
          </span>
          {w.me && (
            <button
              onClick={w.leave}
              className="rounded-full px-4 py-2 text-[12px] font-semibold"
              style={{ background: T.surface, color: T.mic, boxShadow: SHADOW.raisedSm }}
            >
              Leave
            </button>
          )}
        </header>

        {w.staleBuild && (
          <div className="mt-3 rounded-2xl px-4 py-3 text-center text-[12px] font-bold" style={{ background: '#FDECEC', color: T.mic }}>
            New version available — hard-refresh this tab (Ctrl+Shift+R) to get working audio.
          </div>
        )}

        {!w.me ? (
          <NameGate connecting={w.connecting} error={w.error} onJoin={w.join} onDismissError={w.dismissError} />
        ) : (
          <>
            <section className="mt-5">
              <h1 className="text-[24px] font-bold leading-tight" style={{ color: T.ink }}>
                Hey {w.me.name}
              </h1>
              <p className="mt-1 text-sm font-medium" style={{ color: T.inkSecondary }}>
                {w.peers.length === 0
                  ? 'You are the only one here — invite a friend to open this page'
                  : modeAll
                    ? `Everyone hears you (${w.peers.length} online)`
                    : `${someIds.size} selected`}
              </p>
            </section>

            {w.peers.length > 0 && (
              <button
                onClick={modeAll ? () => w.setTarget({ kind: 'some', ids: [...someIds] }) : selectAll}
                className="mt-4 flex items-center gap-2 self-start rounded-full px-4 py-2 text-[13px] font-bold transition-all"
                style={{
                  background: modeAll ? T.ink : T.surface,
                  color: modeAll ? '#fff' : T.inkSecondary,
                  boxShadow: SHADOW.raisedSm,
                }}
                aria-pressed={modeAll}
              >
                <GlobeIcon />
                Everyone
              </button>
            )}

            <ProbeButtons
              selfTest={selfTest}
              micTest={micTest}
              engineState={w.engineState}
              rxRate={w.rxRate}
              onSelfTest={() => void runSelfTest()}
              onMicTest={() => void runMicTest()}
            />

            <div className="mt-3 flex flex-col gap-2">
              {w.peers.map((p) => (
                <PersonRow
                  key={p.id}
                  peer={p}
                  modeAll={modeAll}
                  selected={someIds.has(p.id)}
                  onToggle={() => togglePerson(p.id)}
                />
              ))}
            </div>

            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-4">
              <MicButton disabled={!canTalk} pressed={w.speaking} onStart={startTalking} onEnd={w.stopTalking} />
              <p className="text-[13px] font-medium" style={{ color: T.inkSecondary }}>
                {w.speaking
                  ? `On air → ${audience} ${audience === 1 ? 'person' : 'people'}`
                  : canTalk
                    ? modeAll
                      ? 'Hold to talk to everyone'
                      : 'Hold to talk to your selection'
                    : 'Pick someone to talk to'}
              </p>
              <Waveform active={audioActive} getLevel={getLevel} />
              <span
                className="mt-1 rounded-full px-3.5 py-1.5 text-[11px] font-bold tracking-[0.12em]"
                style={{
                  background: T.surface,
                  color: w.speaking ? T.mic : anyoneReceiving ? T.active : T.inkSecondary,
                  boxShadow: SHADOW.raisedSm,
                }}
              >
                {w.speaking ? 'TRANSMITTING' : receivingFrom ? `RECEIVING · ${receivingFrom.name.toUpperCase()}` : 'CONNECTED'}
              </span>
              {receivingFrom && !w.speaking && (
                <p className="text-[11px] font-medium" style={{ color: T.inkSecondary }}>
                  hearing silence? tap the screen once
                </p>
              )}
            </div>

            {w.me && w.serverState === 'reconnecting' && (
              <div
                className="mb-3 rounded-2xl px-4 py-3 text-center text-[12px] font-bold"
                style={{ background: T.surface, color: T.mic, boxShadow: SHADOW.raisedSm }}
              >
                Connection lost — reconnecting…
              </div>
            )}

            {w.error && (
              <button onClick={w.dismissError} className="mb-3 rounded-2xl px-4 py-3 text-left text-[12px] font-semibold" style={{ background: T.surface, color: T.mic, boxShadow: SHADOW.raisedSm }}>
                {w.error} <span style={{ color: T.inkSecondary }}>— tap to dismiss</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
