/**
 * mesh.ts — many-peer walkie-talkie over WebRTC. (v6)
 *
 * v6 adds life in the background: a screen wake lock while transmitting,
 * visibility handling that never leaves a hot mic, mic revival if the OS
 * ends the track, an instant reconnect when the tab comes back, and a
 * MediaSession so the OS treats the channel as active audio.
 *
 * Why v5: v4 played remote streams through a WebAudio graph, and Chrome can
 * emit SILENCE from createMediaStreamSource() on remote WebRTC streams
 * (sample-rate mismatch / ctx created before stream). v3's <audio> elements
 * worked on this machine, so v5 goes back to them: srcObject + play().
 * "Muted" = element.muted; volume fixed at 1. Selective targeting stays
 * receiver-side via DataChannel listen on/off — SDP is never touched.
 *
 * Metering:
 *   - local mic level: WebAudio analyser on the LOCAL stream (known-good).
 *   - remote levels: getStats() audioLevel (hardware-reported, playback-independent).
 *
 * Signaling roles are deterministic: LOWER id initiates (addTrack before
 * offer); the other answers and attaches its mic to the offered
 * transceiver. No renegotiation after connect, ever.
 * PTT = enable/disable of the single mic track.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export const BUILD_VERSION = 6

export interface PeerInfo {
  id: string
  name: string
  state: 'new' | 'connecting' | 'connected' | 'failed' | 'closed'
  listening: boolean // peer transmits toward us (their choice, via DataChannel)
  speaking: boolean // getStats says their audio is arriving with signal
}

type WireOut =
  | { t: 'offer'; to: string; sdp: RTCSessionDescriptionInit }
  | { t: 'answer'; to: string; sdp: RTCSessionDescriptionInit }
  | { t: 'cand'; to: string; candidate: RTCIceCandidateInit }
  | { t: 'hello'; name: string }
  | { t: 'leave' }

type WireIn =
  | { t: 'welcome'; id: string; name: string; users: { id: string; name: string }[]; v?: number }
  | { t: 'roster'; users: { id: string; name: string }[]; v?: number }
  | { t: 'offer'; from: string; fromName: string; sdp: RTCSessionDescriptionInit }
  | { t: 'answer'; from: string; sdp: RTCSessionDescriptionInit }
  | { t: 'cand'; from: string; candidate: RTCIceCandidateInit }
  | { t: 'error'; code: string; message: string }

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

declare global {
  interface Window {
    __meshDebug?: string[]
  }
}
function dbg(...parts: unknown[]) {
  const w = window as Window & { __meshDebug?: string[] }
  w.__meshDebug ??= []
  w.__meshDebug.push(((performance.now() / 1000) % 1000).toFixed(1) + ' ' + parts.join(' '))
  if (w.__meshDebug.length > 150) w.__meshDebug.shift()
}

// legacy cleanup: old builds left <audio> elements and WebAudio nodes around
if (typeof document !== 'undefined') {
  document.querySelectorAll('audio[id^="walkie-remote-"]').forEach((el) => el.remove())
}

/** Per-peer remote playback: an <audio> element in the DOM. v3-proven. */
function attachAudioElement(id: string, stream: MediaStream) {
  const el = document.createElement('audio')
  el.id = `walkie-remote-${id}`
  el.srcObject = stream
  el.autoplay = true
  el.muted = true // gate CLOSED until the peer transmits to us
  el.volume = 1
  el.setAttribute('playsinline', '')
  el.style.display = 'none'
  document.body.appendChild(el)
  void el.play().catch((e) => dbg('audio-play-ERR', id, String(e)))
  dbg('audio-attach', id)
  return {
    setMuted: (m: boolean) => {
      el.muted = m
    },
    getMuted: () => el.muted,
    play: () => {
      void el.play().catch(() => {})
    },
  }
}

function detachAudioElement(id: string) {
  const el = document.getElementById(`walkie-remote-${id}`) as HTMLAudioElement | null
  if (!el) return
  try {
    el.srcObject = null
    el.remove()
  } catch {
    /* gone */
  }
}

/**
 * Autoplay-unlock on a user gesture. The <audio> elements are already playing
 * (muted), so unmuting is allowed; we also resume the shared AudioContext used
 * for the local mic meter. Call this on ANY pointer/key interaction.
 */
export function unlockWalkieAudio() {
  const w = window as Window & { __walkieCtx?: AudioContext }
  if (!w.__walkieCtx) w.__walkieCtx = new AudioContext()
  if (w.__walkieCtx.state === 'suspended') void w.__walkieCtx.resume().catch(() => {})
  document.querySelectorAll<HTMLAudioElement>('audio[id^="walkie-remote-"]').forEach((el) => {
    void el.play().catch(() => {})
  })
}

/**
 * In-page end-to-end playback self-test (no second user needed):
 * oscillator → RTCPeerConnection loopback → <audio> element → getStats().
 * Verifies the element path actually produces sound output, not just RTP bytes.
 */
export async function walkieSelfTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const oscCtx = new AudioContext()
    await oscCtx.resume().catch(() => {})
    const osc = oscCtx.createOscillator()
    osc.frequency.value = 440
    const dst = oscCtx.createMediaStreamDestination()
    osc.connect(dst)
    osc.start()

    // no STUN needed for loopback; avoids slow gathering on some machines
    const a = new RTCPeerConnection()
    const b = new RTCPeerConnection()
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {})
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {})
    a.addTrack(dst.stream.getAudioTracks()[0], dst.stream)

    let inbound: MediaStream | null = null
    b.ontrack = (e) => {
      inbound = e.streams[0] ?? new MediaStream([e.track])
    }
    const offer = await a.createOffer()
    await a.setLocalDescription(offer)
    await b.setRemoteDescription(a.localDescription!)
    const answer = await b.createAnswer()
    await b.setLocalDescription(answer)
    await a.setRemoteDescription(b.localDescription!)

    const connected = await new Promise<boolean>((res) => {
      if (a.connectionState === 'connected') return res(true)
      a.addEventListener('connectionstatechange', () => a.connectionState === 'connected' && res(true))
      setTimeout(() => res(false), 10000)
    })
    if (!connected) {
      osc.stop()
      void oscCtx.close()
      return { ok: false, detail: 'loopback PC never connected' }
    }

    const el = document.createElement('audio')
    el.srcObject = inbound
    el.autoplay = true
    el.muted = false
    el.volume = 1
    el.style.display = 'none'
    document.body.appendChild(el)
    try {
      await el.play()
    } catch (e) {
      el.remove()
      osc.stop()
      void oscCtx.close()
      return { ok: false, detail: `play() blocked: ${String(e)}` }
    }

    // let it actually sound, then check the received audio LEVEL via stats
    await new Promise((r) => setTimeout(r, 1500))
    let level = 0
    let bytes = 0
    const stats = await b.getStats()
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        bytes = r.bytesReceived ?? 0
        const al = (r as { audioLevel?: number }).audioLevel
        if (typeof al === 'number') level = Math.max(level, al)
      }
    })
    el.remove()
    osc.stop()
    void oscCtx.close()
    const ok = bytes > 500 && level > 0.001
    return {
      ok,
      detail: `rtp ${bytes}B · level ${level.toFixed(3)}${ok ? ' — PLAYBACK PATH OK' : ' — element silent'}`,
    }
  } catch (e) {
    return { ok: false, detail: String(e) }
  }
}

/**
 * Real-mic probe: asks (already-granted) getUserMedia for the mic and reports
 * whether actual signal reaches the browser. This is the "is Windows delivering
 * my voice" check that oscillator-based testing could never answer.
 */
export async function walkieMicTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const ctx = new AudioContext()
    await ctx.resume().catch(() => {})
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 1024
    src.connect(an)
    const buf = new Float32Array(an.fftSize)
    // peak over ~1.2s so a breath/hum counts
    let peak = 0
    const t0 = Date.now()
    await new Promise<void>((res) => {
      const loop = () => {
        an.getFloatTimeDomainData(buf)
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
        if (Date.now() - t0 < 1200) requestAnimationFrame(loop)
        else res()
      }
      loop()
    })
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
    let device = 'default input'
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      const mic = devs.find((d) => d.kind === 'audioinput' && d.deviceId !== 'default')
      if (mic?.label) device = mic.label
    } catch {
      /* labels may be hidden */
    }
    const ok = peak > 0.01
    return {
      ok,
      detail: `peak ${peak.toFixed(3)} from "${device}"${ok ? ' — MIC OK' : ' — no signal (wrong input device? muted in Windows?)'}`,
    }
  } catch (e) {
    return { ok: false, detail: `mic unavailable: ${String(e)}` }
  }
}

interface Peer {
  info: PeerInfo
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  mutedCtl: { setMuted: (m: boolean) => void; getMuted: () => boolean; play: () => void } | null
  pendingCandidates: RTCIceCandidateInit[]
  started: boolean
}

export type TargetMode = { kind: 'all' } | { kind: 'some'; ids: string[] }

export function useWalkieMesh(wsUrl: string) {
  const [me, setMe] = useState<{ id: string; name: string } | null>(null)
  const [peers, setPeers] = useState<Record<string, PeerInfo>>({})
  const [targets, setTargets] = useState<TargetMode>({ kind: 'all' })
  const [speaking, setSpeaking] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [serverState, setServerState] = useState<'offline' | 'online' | 'reconnecting'>('offline')
  const [staleBuild, setStaleBuild] = useState(false)
  const [rxRate, setRxRate] = useState(0) // inbound bytes/sec, all peers
  const [engineState, setEngineState] = useState('idle')

  const wsRef = useRef<WebSocket | null>(null)
  const myIdRef = useRef<string | null>(null)
  const nameRef = useRef('')
  const userLeftRef = useRef(false)
  const backoffRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const peersRef = useRef<Map<string, Peer>>(new Map())
  const micStreamRef = useRef<MediaStream | null>(null)
  const localLevelRef = useRef(0)
  const speakingRef = useRef(false)
  const targetsRef = useRef<TargetMode>({ kind: 'all' })
  targetsRef.current = targets
  const micMeterRef = useRef<{ level: () => number } | null>(null)
  const remoteLevelsRef = useRef<Map<string, number>>(new Map()) // id → audioLevel
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null)

  const setPeer = useCallback((id: string, patch: Partial<PeerInfo>) => {
    setPeers((prev) => {
      const cur = prev[id]
      if (!cur) return prev
      return { ...prev, [id]: { ...cur, ...patch } }
    })
  }, [])

  const send = useCallback((msg: WireOut) => {
    wsRef.current?.send(JSON.stringify(msg))
  }, [])

  // ---- mic: captured once; PTT toggles enabled ----------------------------
  const ensureMic = useCallback(async () => {
    if (micStreamRef.current) return micStreamRef.current
    const w = window as Window & { __walkieCtx?: AudioContext }
    if (!w.__walkieCtx) w.__walkieCtx = new AudioContext()
    if (w.__walkieCtx.state === 'suspended') void w.__walkieCtx.resume().catch(() => {})
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    stream.getAudioTracks().forEach((t) => (t.enabled = false))
    micStreamRef.current = stream
    const src = w.__walkieCtx.createMediaStreamSource(stream)
    const an = w.__walkieCtx.createAnalyser()
    an.fftSize = 1024
    src.connect(an)
    const buf = new Float32Array(an.fftSize)
    micMeterRef.current = {
      level: () => {
        an.getFloatTimeDomainData(buf)
        let s = 0
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
        return Math.min(1, Math.sqrt(s / buf.length) * 6)
      },
    }
    setMicOn(true)
    return stream
  }, [])

  // ---- mobile lifeline: survive backgrounding / a locked screen -------------

  /** If the OS ended our mic track while the tab was frozen, capture a fresh
   *  one and hand it to every sender that was using the dead track. */
  const reviveMic = useCallback(async () => {
    const cur = micStreamRef.current?.getAudioTracks()[0]
    if (cur && cur.readyState === 'live') return
    micStreamRef.current = null
    micMeterRef.current = null
    try {
      const stream = await ensureMic()
      const fresh = stream.getAudioTracks()[0]
      if (!fresh) return
      fresh.enabled = speakingRef.current
      for (const p of peersRef.current.values()) {
        for (const tx of p.pc.getTransceivers()) {
          const old = tx.sender.track
          if (old && old.kind === 'audio' && old.readyState === 'ended') {
            try {
              await tx.sender.replaceTrack(fresh)
            } catch {
              /* transceiver already gone */
            }
          }
        }
      }
    } catch {
      /* permission revoked or no input device */
    }
  }, [ensureMic])

  /** Tell the OS we are live audio so it keeps the channel (and screen-off
   *  playback) alive instead of freezing us as an idle tab. */
  const updateMediaSession = useCallback((active: boolean) => {
    const ms = navigator.mediaSession
    if (!ms) return
    try {
      if (active) {
        ms.metadata = new MediaMetadata({ title: 'Walkie', artist: 'Push-to-talk', album: 'Live channel' })
        ms.playbackState = 'playing'
      } else {
        ms.playbackState = 'none'
        ms.metadata = null
      }
    } catch {
      /* partial MediaSession support */
    }
  }, [])

  /** Hold the screen awake while the button is held (mobile screens lock fast). */
  const acquireWakeLock = useCallback(async () => {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> }
    }
    if (!nav.wakeLock || document.visibilityState !== 'visible') return
    try {
      wakeLockRef.current = await nav.wakeLock.request('screen')
    } catch {
      /* unsupported, denied, or the document lost focus mid-request */
    }
  }, [])

  const releaseWakeLock = useCallback(() => {
    const lock = wakeLockRef.current
    wakeLockRef.current = null
    if (lock) void lock.release().catch(() => {})
  }, [])

  // ---- peer lifecycle -----------------------------------------------------
  const destroyPeer = useCallback((id: string) => {
    const p = peersRef.current.get(id)
    if (!p) return
    try {
      p.pc.close()
    } catch {
      /* closed */
    }
    detachAudioElement(id)
    peersRef.current.delete(id)
    remoteLevelsRef.current.delete(id)
    delete (window as unknown as { __peerNames?: Record<string, string> }).__peerNames?.[id]
    setPeers((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const createPeer = useCallback(
    (remote: { id: string; name: string }): Peer => {
      const myId = myIdRef.current ?? ''
      const isInitiator = remote.id > myId

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      const peer: Peer = {
        info: { id: remote.id, name: remote.name, state: 'new', listening: false, speaking: false },
        pc,
        dc: null,
        mutedCtl: null,
        pendingCandidates: [],
        started: false,
      }
      peersRef.current.set(remote.id, peer)
      setPeers((prev) => ({ ...prev, [remote.id]: { ...peer.info } }))
      ;(window as unknown as { __pcs?: Record<string, RTCPeerConnection> }).__pcs ??= {}
      ;(window as unknown as { __pcs: Record<string, RTCPeerConnection> }).__pcs[remote.id] = pc
      const reg = window as unknown as { __peerNames?: Record<string, string> }
      reg.__peerNames ??= {}
      reg.__peerNames[remote.id] = remote.name

      const mic = micStreamRef.current
      const micTrack = mic?.getAudioTracks()[0]

      const openGate = (on: boolean) => {
        if (on) peer.mutedCtl?.play() // element must be playing before unmute
        peer.mutedCtl?.setMuted(!on)
        setPeer(remote.id, { listening: on })
      }

      const wireDc = (dc: RTCDataChannel) => {
        peer.dc = dc
        dc.onopen = () => {
          dbg('dc-open', remote.name)
          dc.send(JSON.stringify({ t: 'listen', on: speakingRef.current }))
        }
        dc.onmessage = (ev) => {
          try {
            const m = JSON.parse(ev.data as string) as { t: 'listen'; on: boolean }
            if (m.t === 'listen') openGate(m.on)
          } catch {
            /* ignore */
          }
        }
      }
      if (isInitiator) wireDc(pc.createDataChannel('walkie'))
      else pc.ondatachannel = (e) => wireDc(e.channel)

      pc.onicecandidate = (e) => {
        if (e.candidate) send({ t: 'cand', to: remote.id, candidate: e.candidate.toJSON() })
      }
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState
        dbg('pc', remote.name, '->', s)
        if (s === 'connected') setPeer(remote.id, { state: 'connected' })
        else if (s === 'failed') {
          setPeer(remote.id, { state: 'failed' })
          destroyPeer(remote.id)
        } else if (s === 'closed') destroyPeer(remote.id)
        else if (s === 'disconnected') setPeer(remote.id, { state: 'connecting' })
        else if (s === 'connecting') setPeer(remote.id, { state: 'connecting' })
      }
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track])
        peer.mutedCtl = attachAudioElement(remote.id, stream)
        peer.mutedCtl.setMuted(!peer.info.listening)
      }

      if (isInitiator) {
        if (micTrack) pc.addTrack(micTrack, mic!)
        else pc.addTransceiver('audio', { direction: 'recvonly' })
        ;(async () => {
          if (peer.started) return
          peer.started = true
          try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            dbg('offer->', remote.name)
            send({ t: 'offer', to: remote.id, sdp: pc.localDescription!.toJSON() })
          } catch (e) {
            dbg('offer-ERR', remote.name, String(e))
            peer.started = false
          }
        })()
      }
      return peer
    },
    [destroyPeer, send, setPeer],
  )

  const handleSignal = useCallback(
    async (msg: WireIn) => {
      const v = (msg as { v?: number }).v
      if (v !== undefined && v !== BUILD_VERSION) setStaleBuild(true)

      if (msg.t === 'welcome') {
        myIdRef.current = msg.id
        setMe({ id: msg.id, name: msg.name })
        for (const u of msg.users) {
          if (!peersRef.current.has(u.id)) createPeer(u)
          else {
            const p = peersRef.current.get(u.id)!
            if (p.info.name !== u.name) setPeer(u.id, { name: u.name })
          }
        }
        return
      }
      if (msg.t === 'roster') {
        // drop peers that vanished from the roster (their socket died)
        const ids = new Set(msg.users.map((u) => u.id))
        for (const id of [...peersRef.current.keys()]) {
          if (!ids.has(id)) destroyPeer(id)
        }
        for (const u of msg.users) {
          if (u.id === myIdRef.current) continue
          if (!peersRef.current.has(u.id)) createPeer(u)
        }
        return
      }
      if (msg.t === 'error') {
        if (msg.code === 'taken') {
          // another tab/device claimed this name — stop the reconnect tug-of-war
          userLeftRef.current = true
          if (reconnectTimerRef.current !== null) {
            clearTimeout(reconnectTimerRef.current)
            reconnectTimerRef.current = null
          }
          for (const id of [...peersRef.current.keys()]) destroyPeer(id)
          setMe(null)
          setServerState('offline')
        }
        setError(msg.message)
        setConnecting(false)
        wsRef.current?.close()
        return
      }

      if (msg.t === 'offer') {
        let p = peersRef.current.get(msg.from)
        if (!p) p = createPeer({ id: msg.from, name: msg.fromName })
        try {
          if (p.started) {
            dbg('offer-ignore(initiator)', msg.fromName)
            return
          }
          p.started = true
          await p.pc.setRemoteDescription(msg.sdp)
          // attach our mic to the transceiver created by the offer
          const micTrack = micStreamRef.current?.getAudioTracks()[0]
          if (micTrack) {
            const tx = p.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio')
            if (tx) {
              try {
                tx.direction = 'sendrecv'
                await tx.sender.replaceTrack(micTrack)
              } catch (e) {
                dbg('tx-attach-ERR', msg.fromName, String(e))
              }
            }
          }
          for (const c of p.pendingCandidates.splice(0)) await p.pc.addIceCandidate(c).catch(() => {})
          const answer = await p.pc.createAnswer()
          await p.pc.setLocalDescription(answer)
          dbg('answer->', msg.fromName)
          send({ t: 'answer', to: msg.from, sdp: p.pc.localDescription!.toJSON() })
        } catch (e) {
          dbg('answer-ERR', msg.fromName, String(e))
          p.started = false
        }
        return
      }

      const peer = peersRef.current.get(msg.from)
      if (!peer) return
      if (msg.t === 'answer') {
        try {
          if (peer.pc.signalingState === 'have-local-offer') {
            await peer.pc.setRemoteDescription(msg.sdp)
            for (const c of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {})
            dbg('answer<-', peer.info.name)
          }
        } catch (e) {
          dbg('answer-set-ERR', peer.info.name, String(e))
        }
        return
      }
      if (msg.t === 'cand') {
        try {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(msg.candidate)
          else peer.pendingCandidates.push(msg.candidate)
        } catch {
          /* ignore */
        }
      }
    },
    [createPeer, destroyPeer, send, setPeer],
  )

  // ---- connect with username ---------------------------------------------
  const connectWs = useCallback(
    (name: string) => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      ws.onopen = () => {
        backoffRef.current = 0
        ws.send(JSON.stringify({ t: 'hello', name }))
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as WireIn
          if (msg.t === 'welcome') {
            setConnecting(false)
            setServerState('online')
          }
          void handleSignal(msg)
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        wsRef.current = null
        if (userLeftRef.current) return
        setServerState('reconnecting')
        const delay = Math.min(8000, 1000 * 2 ** backoffRef.current)
        backoffRef.current += 1
        reconnectTimerRef.current = window.setTimeout(() => connectWs(name), delay)
      }
      ws.onerror = () => {
        try {
          ws.close()
        } catch {
          /* closing */
        }
      }
    },
    [handleSignal, wsUrl],
  )

  /** Skip the backoff timer — used when the tab regains focus after the OS
   *  froze our socket in the background. */
  const reconnectNow = useCallback(() => {
    if (userLeftRef.current) return
    const rs = wsRef.current?.readyState
    if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    backoffRef.current = 0
    if (nameRef.current) connectWs(nameRef.current)
  }, [connectWs])

  const join = useCallback(
    async (name: string) => {
      setError(null)
      setConnecting(true)
      userLeftRef.current = false
      nameRef.current = name
      try {
        await ensureMic()
      } catch (e) {
        setConnecting(false)
        setError(e instanceof Error ? `Microphone blocked: ${e.message}` : 'Microphone unavailable')
        return
      }
      updateMediaSession(true)
      connectWs(name)
    },
    [connectWs, ensureMic, updateMediaSession],
  )

  // ---- PTT ----------------------------------------------------------------
  const startTalking = useCallback(async () => {
    unlockWalkieAudio() // this press is a gesture: unlock playback too
    if (speakingRef.current) return
    void acquireWakeLock() // keep the screen on while the button is held
    speakingRef.current = true
    setSpeaking(true)
    const t = micStreamRef.current?.getAudioTracks()[0]
    if (t) t.enabled = true
    for (const p of peersRef.current.values()) {
      if (p.dc?.readyState === 'open') {
        try {
          p.dc.send(JSON.stringify({ t: 'listen', on: true }))
        } catch {
          /* ignore */
        }
      }
    }
  }, [acquireWakeLock])

  const stopTalking = useCallback(async () => {
    if (!speakingRef.current) return
    releaseWakeLock()
    speakingRef.current = false
    setSpeaking(false)
    const t = micStreamRef.current?.getAudioTracks()[0]
    if (t) t.enabled = false
    for (const p of peersRef.current.values()) {
      if (p.dc?.readyState === 'open') {
        try {
          p.dc.send(JSON.stringify({ t: 'listen', on: false }))
        } catch {
          /* ignore */
        }
      }
    }
  }, [releaseWakeLock])

  const setTarget = useCallback((t: TargetMode) => {
    setTargets(t)
    // Retarget live while transmitting: gates are on the LISTENING side.
    // Tell peers whether they should hear us; their client applies mute.
    for (const [id, p] of peersRef.current) {
      const targeted = t.kind === 'all' || t.ids.includes(id)
      if (p.dc?.readyState === 'open') {
        try {
          p.dc.send(JSON.stringify({ t: 'listen', on: speakingRef.current && targeted }))
        } catch {
          /* ignore */
        }
      }
    }
  }, [])

  const leave = useCallback(() => {
    userLeftRef.current = true
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    send({ t: 'leave' })
    wsRef.current?.close()
    wsRef.current = null
    for (const id of [...peersRef.current.keys()]) destroyPeer(id)
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    micMeterRef.current = null
    myIdRef.current = null
    nameRef.current = ''
    updateMediaSession(false)
    setMe(null)
    setPeers({})
    setSpeaking(false)
    setMicOn(false)
    setTargets({ kind: 'all' })
    setServerState('offline')
  }, [destroyPeer, send, updateMediaSession])

  // ---- background / locked screen: never hot-mic, reconnect on return -------
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // the screen may lock while held — release PTT so we never leave a hot mic
        if (speakingRef.current) void stopTalking()
        releaseWakeLock()
        return
      }
      // back in the foreground: <audio> elements may have been paused and the
      // socket may have been dropped while the tab was frozen
      unlockWalkieAudio()
      void reviveMic()
      reconnectNow()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [reconnectNow, releaseWakeLock, reviveMic, stopTalking])

  // ---- meters + RX stats polling ------------------------------------------
  useEffect(() => {
    let raf = 0
    let lastRx = -1
    let lastAt = 0
    const tick = async () => {
      localLevelRef.current = micMeterRef.current?.level() ?? 0

      const now = performance.now()
      if (now - lastAt > 1000) {
        // remote levels from getStats audioLevel (hardware-reported, works
        // even while the <audio> element is muted) + rx byte rate
        let total = 0
        for (const [id, pc] of Object.entries(
          (window as unknown as { __pcs?: Record<string, RTCPeerConnection> }).__pcs ?? {},
        )) {
          try {
            const stats = await pc.getStats()
            stats.forEach((r) => {
              if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                total += r.bytesReceived ?? 0
                const al = (r as { audioLevel?: number }).audioLevel
                if (typeof al === 'number') remoteLevelsRef.current.set(id, al)
              }
            })
          } catch {
            /* pc closed */
          }
        }
        if (lastRx >= 0) setRxRate(Math.round((total - lastRx) / ((now - lastAt) / 1000)))
        lastRx = total
        lastAt = now
        setEngineState((window as Window & { __walkieCtx?: AudioContext }).__walkieCtx?.state ?? 'idle')

        setPeers((prev) => {
          let changed = false
          const next = { ...prev }
          for (const [id] of peersRef.current) {
            const lvl = remoteLevelsRef.current.get(id) ?? 0
            const speakingNow = lvl > 0.008
            if ((next[id]?.speaking ?? false) !== speakingNow) {
              next[id] = { ...next[id], speaking: speakingNow }
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---- cleanup ------------------------------------------------------------
  useEffect(
    () => () => {
      wsRef.current?.close()
      for (const p of peersRef.current.values()) {
        p.pc.close()
      }
      peersRef.current.clear()
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  const remoteLevelFor = useCallback((id: string): number => remoteLevelsRef.current.get(id) ?? 0, [])

  return {
    me,
    peers: Object.values(peers),
    speaking,
    micOn,
    connecting,
    error,
    targets,
    serverState,
    staleBuild,
    rxRate,
    engineState,
    localLevelRef,
    remoteLevelFor,
    join,
    leave,
    startTalking,
    stopTalking,
    setTarget,
    dismissError: () => setError(null),
  }
}
