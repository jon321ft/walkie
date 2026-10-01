/**
 * webrtc.ts — serverless P2P push-to-talk.
 *
 * No accounts, no backend: two browsers connect directly over WebRTC.
 * Signaling is manual, via copy-paste "invite codes" (works over any
 * messenger). STUN (Google) punches across typical home NATs.
 *
 * Flow:
 *   Host:   host()            → offerCode  ── send to guest ──┐
 *           acceptReturnCode(answerCode) ◄── guest sends ────┤
 *   Guest:  join(offerCode)   → answerCode ───────────────────┘
 *   Either: startTalking()/stopTalking() — toggles mic + announces
 *           over the DataChannel; audio streams peer-to-peer.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export type Role = 'idle' | 'host' | 'guest'
export type LinkState = 'new' | 'connecting' | 'connected' | 'failed' | 'disconnected' | 'closed'

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const CODE_PREFIX = 'WT1:'

interface Wire {
  t: 'speaking'
  on: boolean
}

function encodeCode(desc: RTCSessionDescriptionInit): string {
  return CODE_PREFIX + btoa(JSON.stringify(desc))
}

function decodeCode(code: string): RTCSessionDescriptionInit {
  const raw = code.trim()
  if (!raw.startsWith(CODE_PREFIX)) throw new Error('That does not look like a Walkie code')
  const desc = JSON.parse(atob(raw.slice(CODE_PREFIX.length))) as RTCSessionDescriptionInit
  if (!desc?.sdp || !desc?.type) throw new Error('Walkie code is incomplete')
  return desc
}

/** RMS audio level (0..~1) for a MediaStream, via WebAudio analyser. */
class AudioMeter {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private buf = new Float32Array(512)

  attach(stream: MediaStream) {
    if (!this.ctx) this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    this.analyser?.disconnect()
    const src = this.ctx.createMediaStreamSource(stream)
    const an = this.ctx.createAnalyser()
    an.fftSize = 1024
    src.connect(an)
    this.analyser = an
  }

  level(): number {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 6) // perceptual boost
  }

  async dispose() {
    try {
      await this.ctx?.close()
    } catch {
      /* already closed */
    }
    this.ctx = null
    this.analyser = null
  }
}

export function useWalkieP2P() {
  const [role, setRole] = useState<Role>('idle')
  const [linkState, setLinkState] = useState<LinkState>('new')
  const [remoteSpeaking, setRemoteSpeaking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [offerCode, setOfferCode] = useState<string | null>(null)
  const [answerCode, setAnswerCode] = useState<string | null>(null)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const senderRef = useRef<RTCRtpSender | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const localMeterRef = useRef<AudioMeter | null>(null)
  const remoteMeterRef = useRef<AudioMeter | null>(null)
  const localLevelRef = useRef(0)
  const remoteLevelRef = useRef(0)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const levelRafRef = useRef(0)

  const linkStateRef = useRef<LinkState>('new')
  linkStateRef.current = linkState

  // ---- polling loop: drive audio level refs (no re-render churn) ----------
  useEffect(() => {
    const tick = () => {
      localLevelRef.current = localMeterRef.current?.level() ?? 0
      remoteLevelRef.current = remoteMeterRef.current?.level() ?? 0
      levelRafRef.current = requestAnimationFrame(tick)
    }
    levelRafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(levelRafRef.current)
  }, [])

  const teardown = useCallback(() => {
    dcRef.current?.close()
    dcRef.current = null
    senderRef.current = null
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    remoteStreamRef.current = null
    audioElRef.current?.remove()
    audioElRef.current = null
    const lm = localMeterRef.current
    const rm = remoteMeterRef.current
    localMeterRef.current = null
    remoteMeterRef.current = null
    void lm?.dispose()
    void rm?.dispose()
    pcRef.current?.close()
    pcRef.current = null
    localLevelRef.current = 0
    remoteLevelRef.current = 0
    setSpeaking(false)
    setRemoteSpeaking(false)
    setLinkState('closed')
  }, [])

  useEffect(() => teardown, [teardown])

  const announce = useCallback((on: boolean) => {
    try {
      dcRef.current?.send(JSON.stringify({ t: 'speaking', on } satisfies Wire))
    } catch {
      /* channel not open yet — audio still flows */
    }
  }, [])

  const wirePeer = useCallback(
    (pc: RTCPeerConnection, isHost: boolean) => {
      if (isHost) {
        const dc = pc.createDataChannel('walkie')
        dcRef.current = dc
      } else {
        pc.ondatachannel = (e) => {
          dcRef.current = e.channel
          e.channel.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data as string) as Wire
              if (msg.t === 'speaking') setRemoteSpeaking(msg.on)
            } catch {
              /* ignore malformed */
            }
          }
        }
      }
      if (dcRef.current) {
        dcRef.current.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data as string) as Wire
            if (msg.t === 'speaking') setRemoteSpeaking(msg.on)
          } catch {
            /* ignore malformed */
          }
        }
      }

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState
        if (s === 'connected') setLinkState('connected')
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          setLinkState(s === 'closed' ? 'closed' : s === 'failed' ? 'failed' : 'disconnected')
        } else if (s === 'connecting') setLinkState('connecting')
      }

      pc.ontrack = (e) => {
        const [stream] = e.streams
        if (!stream) return
        remoteStreamRef.current = stream
        let el = audioElRef.current
        if (!el) {
          el = document.createElement('audio')
          el.setAttribute('aria-hidden', 'true')
          document.body.appendChild(el) // attached: survives focus changes, inspectable
          audioElRef.current = el
        }
        el.srcObject = stream
        el.autoplay = true
        el.muted = false
        void el.play().catch(() => {
          /* autoplay guard: retry on next user gesture */
        })
        if (!remoteMeterRef.current) remoteMeterRef.current = new AudioMeter()
        remoteMeterRef.current.attach(stream)
      }
    },
    [],
  )

  const getMic = useCallback(async (): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    localStreamRef.current = stream
    if (!localMeterRef.current) localMeterRef.current = new AudioMeter()
    localMeterRef.current.attach(stream)
    return stream
  }, [])

  const host = useCallback(async () => {
    setError(null)
    teardown()
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      pcRef.current = pc
      setRole('host')
      setLinkState('connecting')

      const stream = await getMic()
      const [track] = stream.getAudioTracks()
      const sender = pc.addTrack(track, stream)
      senderRef.current = sender
      pc.addTransceiver('audio', { direction: 'recvonly' })
      wirePeer(pc, true)

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve()
        const check = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', check)
            resolve()
          }
        }
        pc.addEventListener('icegatheringstatechange', check)
        setTimeout(resolve, 3000) // don't hang on slow STUN
      })
      setOfferCode(encodeCode(pc.localDescription!))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start hosting')
      teardown()
      setRole('idle')
    }
  }, [getMic, teardown, wirePeer])

  const join = useCallback(
    async (code: string) => {
      setError(null)
      teardown()
      try {
        const offer = decodeCode(code)
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
        pcRef.current = pc
        setRole('guest')
        setLinkState('connecting')

        const stream = await getMic()
        const [track] = stream.getAudioTracks()
        senderRef.current = pc.addTrack(track, stream)
        pc.addTransceiver('audio', { direction: 'recvonly' })
        wirePeer(pc, false)

        await pc.setRemoteDescription(offer)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') return resolve()
          const check = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', check)
              resolve()
            }
          }
          pc.addEventListener('icegatheringstatechange', check)
          setTimeout(resolve, 3000)
        })
        setAnswerCode(encodeCode(pc.localDescription!))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not join with that code')
        teardown()
        setRole('idle')
      }
    },
    [getMic, teardown, wirePeer],
  )

  const acceptReturnCode = useCallback(async (code: string) => {
    setError(null)
    try {
      const answer = decodeCode(code)
      const pc = pcRef.current
      if (!pc || pc.signalingState === 'stable') throw new Error('No pending invite — host a channel first')
      await pc.setRemoteDescription(answer)
      setLinkState('connecting')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid return code')
    }
  }, [])

  const startTalking = useCallback(() => {
    const track = senderRef.current?.track
    if (!track || !pcRef.current) return
    track.enabled = true
    setSpeaking(true)
    announce(true)
  }, [announce])

  const stopTalking = useCallback(() => {
    const track = senderRef.current?.track
    if (!track) return
    track.enabled = false
    setSpeaking(false)
    announce(false)
  }, [announce])

  const hangUp = useCallback(() => {
    teardown()
    setRole('idle')
    setOfferCode(null)
    setAnswerCode(null)
    setLinkState('new')
  }, [teardown])

  return {
    role,
    linkState,
    speaking,
    remoteSpeaking,
    error,
    offerCode,
    answerCode,
    localLevelRef,
    remoteLevelRef,
    host,
    join,
    acceptReturnCode,
    startTalking,
    stopTalking,
    hangUp,
    dismissError: () => setError(null),
  }
}
