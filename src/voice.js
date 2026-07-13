// src/voice.js — Proximity voice. Transport priority:
//   1. WebRTC P2P (STUN)            — best latency
//   2. WebRTC via TURN (env config) — covers symmetric NATs, still low latency
//   3. socket.io PCM relay          — LAST resort. TCP means head-of-line
//      blocking (a lost packet stalls the stream), so quality degrades under
//      loss — but degraded audio beats the silence it replaces. Only engages
//      when both WebRTC paths stay down for a peer.

const VOICE_RANGE         = 42
const PANIC_RMS_THRESHOLD = 0.18
const PANIC_COOLDOWN      = 1.4
const RECONNECT_MAX_WAIT  = 16000   // ms — cap for exponential back-off
const RELAY_GRACE_MS      = 8000    // ms — WebRTC gets this long before relay kicks in
const RELAY_RATE          = 16000   // Hz — mono PCM sample rate for relayed audio

// VAD (Voice Activity Detection) — gates ONLY the PCM relay stream (bandwidth)
// and the HUD mic indicator. The WebRTC track itself is ALWAYS transmitting
// (outside push-to-talk mode): Opus DTX makes silence nearly free, the mic
// constraints already run noise suppression, and VAD-muting the track is what
// kept silencing quiet laptop mics entirely. Breathing leaking through is a
// horror feature, not a bug.
// Thresholds adapt to each mic's own measured noise floor.
const VAD_MIN_OPEN   = 0.006  // absolute floor for the open threshold
const VAD_MIN_CLOSE  = 0.003  // absolute floor for the close threshold
const VAD_HANGOVER   = 0.5    // seconds — keep gate open this long after RMS drops
const VAD_START_OPEN_MS = 5000 // relay transmits unconditionally this long after start

// STUN handles NAT discovery; a real TURN server (configured via env — see
// .env.example) is REQUIRED for peers behind symmetric NATs / blocked UDP.
// The old anonymous openrelay TURN is dead (now requires an account), so it
// was removed — dead TURN entries only slow down ICE gathering.
const STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
]

export class VoiceChat {
    constructor(socket, audioSystem = null) {
        this.socket      = socket
        this.audioSystem = audioSystem
        this.role        = null
        this.peerRoles   = new Map()
        this.localStream = null
        this.peerConnections = new Map()   // peerId → RTCPeerConnection
        this.remoteGraphs    = new Map()   // peerId → {source, filter, gain}
        this.analyser     = null
        this.analyserData = null
        this._ownCtx      = null
        this._panicCooldown = 0
        this._levelTimer    = 0
        this._breathWindow  = []
        this._fearDistortionLevel = 0
        this._micAttempted  = false
        this._lastCurveFear = null         // last fear level baked into the distortion curve
        this._queuedOffers  = []           // offers that arrived before mic was ready
        this._queuedIce     = new Map()    // peerId → RTCIceCandidate[]
        this._reconnectTimers = new Map()  // peerId → setTimeout handle
        this._reconnectDelay  = new Map()  // peerId → current back-off ms
        this.onPanicCue = null

        // VAD state
        this._vadOpen        = false
        this._vadCloseTimer  = 0      // hangover countdown
        this._noiseFloor     = 0.004  // adaptive per-mic quiet level (EMA)
        this._vadOpenUntil   = 0      // Date.now() deadline for the start-open grace
        this._pushToTalk     = true   // hold V to talk; release = mic muted
        this._pttHeld        = false
        this._currentRMS     = 0
        this._voiceFear      = 0      // 0..1 — sustained loudness/breathing → fear surrogate

        // ICE — STUN immediately; TURN credentials load async from env config
        this._iceServers = [...STUN_SERVERS]
        this._turnReady  = false
        this._icePromise = this._initIceServers()

        // Transport health + socket.io relay fallback
        this._voiceOut     = null        // dedicated output gain — full volume, not the SFX master
        this._startedAt    = 0           // Date.now() when start() ran
        this._pcCreatedAt  = new Map()   // peerId → creation timestamp
        this._webrtcLive   = new Set()   // peerIds currently connected over WebRTC
        this._relaySend    = false       // true → stream mic PCM over socket.io
        this._relayRx      = new Map()   // peerId → next scheduled playback time
        this._relayProc    = null        // ScriptProcessorNode capturing mic PCM
        this._statusEl     = null
        this._lastStatusText = null

        this._wireSignaling()

        // Browsers keep AudioContexts suspended until a user gesture —
        // retry the unlock (and element playback) on any input, forever.
        this._unlockHandler = () => this._unlockAudio()
        document.addEventListener('pointerdown', this._unlockHandler)
        document.addEventListener('keydown', this._unlockHandler)
        document.addEventListener('touchstart', this._unlockHandler)
    }

    _unlockAudio() {
        const ctx = this._getAudioContext()
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
        for (const graph of this.remoteGraphs.values()) {
            if (graph.el && graph.el.paused) graph.el.play().catch(() => {})
        }
    }

    /** Public: resume audio + retry element playback. main.js calls this from
     *  REAL user-gesture handlers (lobby buttons) — the only place browsers
     *  are guaranteed to honour AudioContext.resume(). */
    unlockAudio() { this._unlockAudio() }

    /**
     * Resolve the ICE server list. TURN is required for symmetric NATs; config
     * comes from Vite env (see .env.example):
     *   VITE_TURN_CREDENTIALS_URL — a Metered-style endpoint returning a JSON
     *     array of iceServers (create a free app at metered.ca, 50 GB/mo)
     *   VITE_TURN_URL / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL — static TURN
     */
    async _initIceServers() {
        const servers = [...STUN_SERVERS]
        const credUrl = import.meta.env?.VITE_TURN_CREDENTIALS_URL
        const turnUrl = import.meta.env?.VITE_TURN_URL
        try {
            if (credUrl) {
                const ctrl = new AbortController()
                const timer = setTimeout(() => ctrl.abort(), 3500)
                const resp = await fetch(credUrl, { signal: ctrl.signal })
                clearTimeout(timer)
                if (resp.ok) {
                    const fetched = await resp.json()
                    if (Array.isArray(fetched) && fetched.length) {
                        servers.push(...fetched)
                        this._turnReady = true
                        console.log(`[Voice] TURN credentials loaded (${fetched.length} ICE entries)`)
                    }
                }
            } else if (turnUrl) {
                servers.push({
                    urls:       turnUrl,
                    username:   import.meta.env?.VITE_TURN_USERNAME   ?? '',
                    credential: import.meta.env?.VITE_TURN_CREDENTIAL ?? '',
                })
                this._turnReady = true
                console.log('[Voice] Static TURN server configured')
            }
        } catch (err) {
            console.warn('[Voice] TURN credential fetch failed:', err.message)
        }
        if (!this._turnReady) {
            console.warn('[Voice] No TURN server configured — cross-network P2P may fail for strict NATs; the socket relay will cover those peers. Set VITE_TURN_CREDENTIALS_URL (see .env.example).')
        }
        this._iceServers = servers
        return servers
    }

    // ── PUBLIC ──────────────────────────────────────────────────────────────────

    async start(role, peers = []) {
        this.stop()
        this.role      = role
        this.peerRoles = new Map(peers.map(p => [p.id, p.role]))
        this._micAttempted = false
        this._breathWindow.length = 0
        this._startedAt = Date.now()
        this._vadOpen = true
        this._vadOpenUntil = Date.now() + VAD_START_OPEN_MS

        console.log(`[Voice] Starting as ${role}; peers=${peers.map(p => `${p.id}:${p.role}`).join(', ') || 'none'}`)

        // Give TURN credentials up to 4 s to arrive before dialing peers —
        // connections made without TURN can't reach symmetric-NAT peers.
        try {
            await Promise.race([this._icePromise, new Promise(r => setTimeout(r, 4000))])
        } catch {}

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false,
            })
            this._setupMicAnalyser()
        } catch (err) {
            console.warn('[Voice] Microphone unavailable:', err.message)
        } finally {
            this._micAttempted = true
            const queued = this._queuedOffers.splice(0)
            for (const offer of queued) this._handleVoiceOffer(offer)
        }

        for (const peer of peers) {
            if (this._shouldInitiate(peer.id)) this._connectPeer(peer.id, true)
        }
    }

    /**
     * @param {number} dt
     * @param {Map<string,{distance:number,lineOfSight:boolean,position?:{x,y,z}}>|null} peers
     *        Per-peer proximity info keyed by socket id. Peers without an entry
     *        (no position received yet) stay audible at a default mid volume.
     */
    update(dt, peers = null) {
        this._updateTransportHealth()
        this._updateRemoteVolumes(peers)
        this._updateMicLevel(dt)
    }

    stop() {
        for (const handle of this._reconnectTimers.values()) clearTimeout(handle)
        this._reconnectTimers.clear()
        this._reconnectDelay.clear()

        try { this._relayProc?.disconnect() } catch {}
        this._relayProc = null
        this._relaySend = false
        this._pcCreatedAt.clear()
        this._webrtcLive.clear()
        this._relayRx.clear()

        for (const pc of this.peerConnections.values()) { try { pc.close() } catch {} }
        this.peerConnections.clear()

        for (const graph of this.remoteGraphs.values()) {
            try { graph.el?.pause(); if (graph.el) { graph.el.srcObject = null; graph.el.remove() } } catch {}
            try { graph.source.disconnect()      } catch {}
            try { graph.panner?.disconnect()     } catch {}
            try { graph.highpass?.disconnect()   } catch {}
            try { graph.filter.disconnect()      } catch {}
            try { graph.distortion?.disconnect() } catch {}
            try { graph.gain.disconnect()        } catch {}
        }
        this.remoteGraphs.clear()

        this.localStream?.getTracks().forEach(t => t.stop())
        this.localStream  = null
        this.analyser     = null
        this.analyserData = null
        this._micAttempted = false
        this._breathWindow.length = 0
    }

    // ── PRIVATE — SIGNALING ──────────────────────────────────────────────────────

    _wireSignaling() {
        this.socket.on('voiceOffer', ({ fromId, description }) => {
            this._handleVoiceOffer({ fromId, description })
        })

        this.socket.on('voiceAnswer', async ({ fromId, description }) => {
            const pc = this.peerConnections.get(fromId)
            if (!pc || pc.signalingState === 'stable') return
            try {
                await pc.setRemoteDescription(description)
                await this._flushQueuedIce(fromId)
                console.log(`[Voice] answer accepted from ${fromId}`)
            } catch (err) {
                console.warn('[Voice] Answer rejected:', err.message)
                this._scheduleReconnect(fromId)
            }
        })

        this.socket.on('voiceIceCandidate', async ({ fromId, candidate }) => {
            if (!candidate) return
            const pc = this.peerConnections.get(fromId)
            if (!pc || !pc.remoteDescription) {
                this._queueIce(fromId, candidate)
                return
            }
            try {
                await pc.addIceCandidate(candidate)
            } catch (err) {
                console.warn('[Voice] ICE candidate rejected:', err.message)
            }
        })

        this.socket.on('voicePanic', ({ fromId, type = 'panic' }) => {
            if (this.role !== 'hunter') return
            if (this.onPanicCue) this.onPanicCue(fromId, type)
        })

        this.socket.on('peerDisconnected', ({ id }) => {
            this._closePeer(id, false)
            this.peerRoles.delete(id)
            this._pcCreatedAt.delete(id)
            this._webrtcLive.delete(id)
            this._relayRx.delete(id)
        })

        // Relayed PCM audio from a peer whose WebRTC path never connected
        this.socket.on('voiceData', ({ id, chunk }) => {
            this._playRelayChunk(id, chunk)
        })
    }

    async _handleVoiceOffer({ fromId, description }) {
        if (!description) return
        if (!this.role) {
            this._queuedOffers.push({ fromId, description }); return
        }
        if (!this.localStream && !this._micAttempted) {
            this._queuedOffers.push({ fromId, description }); return
        }
        try {
            const pc = this._connectPeer(fromId, false)
            // If we're the initiator side for this peer, reset the connection first
            if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-remote-offer') {
                // Unexpected state — close and recreate
                this._closePeer(fromId, false)
                const fresh = this._connectPeer(fromId, false)
                await fresh.setRemoteDescription(description)
                const answer = await fresh.createAnswer()
                await fresh.setLocalDescription(answer)
                this.socket.emit('voiceAnswer', { targetId: fromId, description: fresh.localDescription })
                await this._flushQueuedIce(fromId)
                return
            }
            await pc.setRemoteDescription(description)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            this.socket.emit('voiceAnswer', { targetId: fromId, description: pc.localDescription })
            await this._flushQueuedIce(fromId)
            console.log(`[Voice] answer sent to ${fromId}`)
        } catch (err) {
            console.warn('[Voice] Offer handling failed:', err.message)
            this._closePeer(fromId, false)
            this._scheduleReconnect(fromId)
        }
    }

    // Lower socket ID initiates the offer — deterministic, no simultaneous-offer collision.
    _shouldInitiate(peerId) {
        return String(this.socket.id || '') < String(peerId || '')
    }

    _connectPeer(peerId, initiate) {
        if (this.peerConnections.has(peerId)) return this.peerConnections.get(peerId)

        const pc = new RTCPeerConnection({
            iceServers:    this._iceServers,
            bundlePolicy:  'max-bundle',
            rtcpMuxPolicy: 'require',
        })
        this.peerConnections.set(peerId, pc)
        this._pcCreatedAt.set(peerId, Date.now())

        if (this.localStream?.getAudioTracks().length) {
            for (const track of this.localStream.getTracks()) {
                pc.addTrack(track, this.localStream)
            }
        } else {
            // No mic — listen only
            pc.addTransceiver('audio', { direction: 'recvonly' })
        }

        pc.onicecandidate = ({ candidate }) => {
            if (candidate) {
                this.socket.emit('voiceIceCandidate', { targetId: peerId, candidate })
            }
        }

        pc.ontrack = ({ streams }) => {
            const stream = streams[0]
            if (stream) {
                console.log(`[Voice] remote track from ${peerId}`)
                this._setupRemoteGraph(peerId, stream)
            }
        }

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState
            console.log(`[Voice] ${peerId} → ${state}`)
            if (state === 'failed') {
                this._closePeer(peerId, false)
                this._scheduleReconnect(peerId)
            } else if (state === 'connected') {
                // Reset back-off on success
                this._reconnectDelay.set(peerId, 2000)
                clearTimeout(this._reconnectTimers.get(peerId))
                this._reconnectTimers.delete(peerId)
            } else if (state === 'disconnected') {
                // Give it 5 s to self-recover before forcing a reconnect
                const handle = setTimeout(() => {
                    if (pc.connectionState === 'disconnected') {
                        this._closePeer(peerId, false)
                        this._scheduleReconnect(peerId)
                    }
                }, 5000)
                this._reconnectTimers.set(peerId, handle)
            }
        }

        if (initiate) {
            queueMicrotask(async () => {
                try {
                    const offer = await pc.createOffer()
                    await pc.setLocalDescription(offer)
                    this.socket.emit('voiceOffer', { targetId: peerId, description: pc.localDescription })
                    console.log(`[Voice] offer sent to ${peerId}`)
                } catch (err) {
                    console.warn('[Voice] Offer failed:', err.message)
                    this._scheduleReconnect(peerId)
                }
            })
        }

        return pc
    }

    _scheduleReconnect(peerId) {
        if (!this.role || !this._shouldInitiate(peerId)) return   // only initiator reconnects
        clearTimeout(this._reconnectTimers.get(peerId))
        const delay = Math.min(
            this._reconnectDelay.get(peerId) ?? 2000,
            RECONNECT_MAX_WAIT
        )
        this._reconnectDelay.set(peerId, delay * 1.5)
        console.log(`[Voice] reconnecting to ${peerId} in ${delay} ms`)
        const handle = setTimeout(() => {
            this._reconnectTimers.delete(peerId)
            if (!this.peerConnections.has(peerId) && this.role) {
                this._connectPeer(peerId, true)
            }
        }, delay)
        this._reconnectTimers.set(peerId, handle)
    }

    _queueIce(peerId, candidate) {
        if (!this._queuedIce.has(peerId)) this._queuedIce.set(peerId, [])
        this._queuedIce.get(peerId).push(candidate)
    }

    async _flushQueuedIce(peerId) {
        const pc     = this.peerConnections.get(peerId)
        const queued = this._queuedIce.get(peerId)
        if (!pc || !pc.remoteDescription || !queued?.length) return
        this._queuedIce.delete(peerId)
        for (const candidate of queued) {
            try { await pc.addIceCandidate(candidate) } catch {}
        }
    }

    // ── PRIVATE — AUDIO GRAPHS ───────────────────────────────────────────────────

    _setupMicAnalyser() {
        const ctx = this._getAudioContext()
        if (!ctx || !this.localStream) return
        if (ctx.state === 'suspended') ctx.resume()
        const source = ctx.createMediaStreamSource(this.localStream)
        this.analyser = ctx.createAnalyser()
        this.analyser.fftSize = 512
        this.analyserData = new Uint8Array(this.analyser.fftSize)
        source.connect(this.analyser)
        this._setupRelayCapture(ctx, source)
    }

    // ── PRIVATE — SOCKET.IO AUDIO RELAY (fallback when WebRTC can't connect) ────

    /** Capture mic PCM so it can be streamed over the socket when needed.
     *  Costs nothing while _relaySend is false (callback exits immediately). */
    _setupRelayCapture(ctx, source) {
        // ScriptProcessor is deprecated but universally supported; 4096 ≈ 85 ms @48k
        const proc = ctx.createScriptProcessor(4096, 1, 1)
        proc.onaudioprocess = (e) => {
            if (!this._relaySend || !this.isTransmitting()) return
            const input = e.inputBuffer.getChannelData(0)
            const pcm = this._downsampleToInt16(input, ctx.sampleRate, RELAY_RATE)
            if (pcm) this.socket.volatile.emit('voiceData', pcm.buffer)
        }
        source.connect(proc)
        // A ScriptProcessor only fires when connected to the destination — mute it
        const sink = ctx.createGain()
        sink.gain.value = 0
        proc.connect(sink)
        sink.connect(ctx.destination)
        this._relayProc = proc
    }

    _downsampleToInt16(input, fromRate, toRate) {
        const ratio  = fromRate / toRate
        const outLen = Math.floor(input.length / ratio)
        if (outLen <= 0) return null
        const out = new Int16Array(outLen)
        for (let i = 0; i < outLen; i++) {
            const idx  = i * ratio
            const i0   = Math.floor(idx)
            const i1   = Math.min(input.length - 1, i0 + 1)
            const s    = input[i0] + (input[i1] - input[i0]) * (idx - i0)
            out[i] = Math.max(-32768, Math.min(32767, s * 32767))
        }
        return out
    }

    /** Play a relayed PCM chunk through the peer's normal spatial graph, so
     *  proximity volume, LOS muffle and fear distortion still apply. */
    _playRelayChunk(peerId, chunk) {
        if (this._webrtcLive.has(peerId)) return   // already hearing them over WebRTC
        const ctx = this._getAudioContext()
        if (!ctx || ctx.state !== 'running') return
        const graph = this._ensureGraph(peerId)
        if (!graph) return

        let int16
        try {
            if (chunk instanceof ArrayBuffer)          int16 = new Int16Array(chunk)
            else if (ArrayBuffer.isView(chunk))        int16 = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
            else return
        } catch { return }
        if (!int16.length) return

        let buf
        try { buf = ctx.createBuffer(1, int16.length, RELAY_RATE) } catch { return }
        const ch = buf.getChannelData(0)
        for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768

        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(graph.panner)
        // Schedule chunks back-to-back for gapless playback
        const nextAt = Math.max(ctx.currentTime + 0.02, this._relayRx.get(peerId) ?? 0)
        src.start(nextAt)
        this._relayRx.set(peerId, nextAt + buf.duration)
    }

    /** Decide per-peer transport: WebRTC when connected; otherwise, after a grace
     *  period, stream/accept audio via the socket.io relay. Runs at ~10 Hz. */
    _updateTransportHealth() {
        if (!this.role || !this.peerRoles.size) return
        const now = Date.now()
        let needRelay = false

        for (const peerId of this.peerRoles.keys()) {
            const pc = this.peerConnections.get(peerId)
            if (pc && pc.connectionState === 'connected') {
                this._webrtcLive.add(peerId)
                continue
            }
            this._webrtcLive.delete(peerId)
            const since = this._pcCreatedAt.get(peerId) ?? this._startedAt
            if (now - since > RELAY_GRACE_MS) needRelay = true
        }

        if (needRelay !== this._relaySend) {
            this._relaySend = needRelay
            console.log(`[Voice] transport: ${needRelay ? 'socket.io RELAY active (WebRTC unreachable for ≥1 peer)' : 'all peers on WebRTC P2P'}`)
        }
        this._updateStatusIndicator()
    }

    _updateStatusIndicator() {
        if (!this._statusEl) this._statusEl = document.getElementById('voice-status')
        if (!this._statusEl) return
        let text, color
        if (!this.peerRoles.size)                          { text = '';                      color = '#888' }
        else if (!this.localStream && this._micAttempted)  { text = '🎙 VOICE: NO MIC';      color = '#ff003c' }
        else if (this._webrtcLive.size >= this.peerRoles.size) { text = '🎙 VOICE: P2P';     color = '#00ffcc' }
        else if (this._relaySend)                          { text = '🎙 VOICE: RELAY';       color = '#ff9900' }
        else                                               { text = '🎙 VOICE: CONNECTING…'; color = '#888' }
        if (text !== this._lastStatusText) {
            this._lastStatusText = text
            this._statusEl.textContent = text
            this._statusEl.style.color = color
        }
    }

    /** Voice gets its own output gain at FULL volume — the game SFX master sits
     *  at 0.4, which made voices quiet even when everything else worked. */
    _getVoiceOut(ctx) {
        if (!this._voiceOut) {
            this._voiceOut = ctx.createGain()
            this._voiceOut.gain.value = 1.0
            this._voiceOut.connect(ctx.destination)
        }
        return this._voiceOut
    }

    /** Build (or return) the per-peer spatial chain: panner → filter → distortion
     *  → gain → voiceOut. Works with no WebRTC stream so relayed PCM can use it. */
    _ensureGraph(peerId) {
        const existing = this.remoteGraphs.get(peerId)
        if (existing) return existing
        const ctx = this._getAudioContext()
        if (!ctx) return null
        if (ctx.state === 'suspended') ctx.resume()

        const panner     = ctx.createPanner()
        const highpass   = ctx.createBiquadFilter()   // cuts room rumble / AC hum from always-on mics
        const filter     = ctx.createBiquadFilter()
        const distortion = ctx.createWaveShaper()
        const gain       = ctx.createGain()

        // HRTF panner for directional 3D voice — distance attenuation handled by gain node
        panner.panningModel  = 'HRTF'
        panner.distanceModel = 'linear'
        panner.refDistance   = 1
        panner.maxDistance   = VOICE_RANGE
        panner.rolloffFactor = 0   // disable panner distance falloff; gain node handles it
        panner.coneInnerAngle = 360
        panner.coneOuterAngle = 360
        panner.coneOuterGain  = 0
        // Start the peer ahead of the listener — updated via updateSpatialAudio()
        if (panner.positionX) { panner.positionX.value = 0; panner.positionY.value = 0; panner.positionZ.value = -5 }
        else                  { try { panner.setPosition(0, 0, -5) } catch {} }

        highpass.type            = 'highpass'
        highpass.frequency.value = 120
        highpass.Q.value         = 0.7
        filter.type            = 'lowpass'
        filter.frequency.value = 7000
        distortion.curve       = this._makeDistortionCurve(0)
        distortion.oversample  = '2x'
        gain.gain.value        = 0

        // Chain: [source] → panner (HRTF) → highpass (hum cut) → filter (LOS muffle) → distortion (fear) → gain (volume) → voiceOut
        panner.connect(highpass)
        highpass.connect(filter)
        filter.connect(distortion)
        distortion.connect(gain)
        gain.connect(this._getVoiceOut(ctx))
        const graph = { source: null, panner, highpass, filter, distortion, gain, el: null }
        this.remoteGraphs.set(peerId, graph)
        return graph
    }

    /** Attach a live WebRTC stream to the peer's graph. */
    _setupRemoteGraph(peerId, stream) {
        const graph = this._ensureGraph(peerId)
        if (!graph || graph.source) return
        const ctx = this._getAudioContext()
        if (!ctx) return

        // Chrome bug workaround (crbug.com/121673): a remote WebRTC stream feeds
        // NO samples into WebAudio unless it is also attached to a media element.
        // This muted <audio> never plays out loud — it just primes the stream so
        // the graph actually receives audio. It is BOTH referenced (graph.el)
        // and attached to the DOM: a detached media element risks GC and some
        // browsers deprioritize playback for elements outside the document.
        const el = new Audio()
        el.srcObject = stream
        el.muted    = true
        el.autoplay = true
        el.setAttribute('playsinline', '')   // iOS: never go fullscreen
        this._getAudioSink().appendChild(el)
        el.play().catch(() => {})   // retried on the next user gesture by _unlockAudio

        graph.el     = el
        graph.source = ctx.createMediaStreamSource(stream)
        graph.source.connect(graph.panner)
    }

    /** Hidden DOM container that keeps every remote <audio> element alive. */
    _getAudioSink() {
        let sink = document.getElementById('voice-audio-sink')
        if (!sink) {
            sink = document.createElement('div')
            sink.id = 'voice-audio-sink'
            sink.style.display = 'none'
            document.body.appendChild(sink)
        }
        return sink
    }

    _updateRemoteVolumes(peers) {
        if (!this.remoteGraphs.size) return
        const ctx = this._getAudioContext()
        if (!ctx) return
        const fear = this._fearDistortionLevel
        const fearFreq = fear > 0.7 ? 1200 : fear > 0.4 ? 3500 : 7000
        // Each connected peer gets volume/muffle from THEIR OWN distance & LOS —
        // every player hears every other player correctly regardless of role.
        for (const [peerId, graph] of this.remoteGraphs) {
            const info = peers?.get?.(peerId)
            const dist = info && Number.isFinite(info.distance) ? info.distance : 6
            const los  = info ? info.lineOfSight !== false : true
            const base   = Math.max(0, Math.min(1, 1 - dist / VOICE_RANGE))
            const volume = Math.pow(base, 1.35) * (los ? 1 : 0.45)
            const freq   = Math.min(los ? 7000 : 750, fearFreq)
            graph.gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.08)
            graph.filter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.08)
        }
    }

    _updateMicLevel(dt) {
        this._panicCooldown = Math.max(0, this._panicCooldown - dt)

        // FAIL OPEN: if the analyser can't actually read the mic (no analyser, or
        // AudioContext still suspended → RMS reads 0 forever), do NOT let the VAD
        // gate mute the track — that silenced everyone permanently.
        const ctx = this._getAudioContext()
        if (!this.analyser || !this.analyserData || !ctx || ctx.state !== 'running') {
            const open = this._pushToTalk ? this._pttHeld : true
            this._vadOpen = open
            this._setMicTransmitting(open)
            return
        }

        this._levelTimer += dt
        if (this._levelTimer < 0.08) return
        const tickDt = this._levelTimer
        this._levelTimer = 0

        this.analyser.getByteTimeDomainData(this.analyserData)
        let sum = 0
        for (const v of this.analyserData) {
            const c = (v - 128) / 128
            sum += c * c
        }
        const rms = Math.sqrt(sum / this.analyserData.length)
        this._currentRMS = rms

        // ── ADAPTIVE VAD — gates the relay stream + HUD indicator only ──
        // Noise floor tracks THIS mic's quiet level: falls fast, rises slowly —
        // so thresholds fit quiet laptop mics and loud headsets alike.
        if (rms < this._noiseFloor) this._noiseFloor += (rms - this._noiseFloor) * 0.30
        else                        this._noiseFloor += (rms - this._noiseFloor) * 0.02
        const openThresh  = Math.max(VAD_MIN_OPEN,  this._noiseFloor * 2.5 + 0.003)
        const closeThresh = Math.max(VAD_MIN_CLOSE, this._noiseFloor * 1.4)

        if (this._pttHeld) {
            this._vadOpen = true
        } else if (this._pushToTalk) {
            this._vadOpen = false
        } else if (Date.now() < this._vadOpenUntil) {
            // Round-start grace: relay transmits too, so players immediately hear
            // that voice works instead of wondering whether it is broken.
            this._vadOpen = true
        } else {
            if (rms >= openThresh)         { this._vadOpen = true;  this._vadCloseTimer = VAD_HANGOVER }
            else if (rms < closeThresh)    { this._vadCloseTimer = Math.max(0, this._vadCloseTimer - tickDt); if (this._vadCloseTimer <= 0) this._vadOpen = false }
        }

        // The WebRTC track is ALWAYS on outside PTT-only mode — never VAD-muted.
        this._setMicTransmitting(this._pushToTalk ? this._pttHeld : true)

        // ── Voice-derived fear (used as emotion fallback when face cam fails) ──
        // Loud sustained speech / hyperventilating → high voice fear.
        // Built from peak + EMA of recent RMS samples.
        const ema = this._voiceFear * 0.92 + Math.min(1, rms * 5) * 0.08
        this._voiceFear = Math.max(0, Math.min(1, ema))

        // ── Hunter cues — only the PREY's voice generates panic / breathing pulses ──
        if (this.role !== 'prey') return

        if (rms >= PANIC_RMS_THRESHOLD && this._panicCooldown <= 0) {
            this._panicCooldown = PANIC_COOLDOWN
            this.socket.emit('voicePanic', { level: rms, type: 'panic' })
            this._breathWindow.length = 0
            return
        }

        this._breathWindow.push(rms)
        if (this._breathWindow.length > 50) this._breathWindow.shift()
        if (this._breathWindow.length >= 50) {
            const avg = this._breathWindow.reduce((a, b) => a + b, 0) / this._breathWindow.length
            const isBreathing = avg > 0.02 && avg < 0.08
            if (isBreathing && this._panicCooldown <= 0) {
                this._panicCooldown = PANIC_COOLDOWN * 0.5
                this.socket.emit('voicePanic', { level: avg, type: 'breathing' })
            }
        }
    }

    /** Enables/disables the local audio track based on VAD state — saves bandwidth, kills room noise. */
    _setMicTransmitting(on) {
        if (!this.localStream) return
        const track = this.localStream.getAudioTracks()[0]
        if (!track) return
        if (track.enabled !== on) track.enabled = on
    }

    /** 0..1 — sustained voice intensity. Used as emotion fallback when face cam BPM is unreliable. */
    getVoiceFear() { return this._voiceFear }
    /** True when local mic is currently passing audio to peers. */
    isTransmitting() { return this._pttHeld || this._vadOpen }
    /** Toggle push-to-talk mode. When enabled, only transmits while pttHeld(true) is set. */
    setPushToTalk(enabled) { this._pushToTalk = !!enabled; if (!enabled) this._pttHeld = false }
    /** Press/release PTT. While held, always transmits regardless of VAD mode. */
    pttHeld(held) { this._pttHeld = !!held }

    /**
     * Update HRTF listener pose and per-peer speaker positions for 3D directional audio.
     * @param {{x,y,z}} listenerPos  — camera/player world position
     * @param {{x,y,z}} listenerFwd  — camera forward unit vector
     * @param {{x,y,z}} listenerUp   — camera up unit vector
     * @param {Map<string,{position?:{x,y,z}}>|null} peers — per-peer info keyed by socket id
     */
    updateSpatialAudio(listenerPos, listenerFwd, listenerUp, peers = null) {
        const ctx = this._getAudioContext()
        if (!ctx || !listenerPos || !listenerFwd) return

        const listener = ctx.listener
        // Use AudioParam API where available (more precise, avoids scheduling jitter)
        if (listener.positionX) {
            listener.positionX.value = listenerPos.x
            listener.positionY.value = listenerPos.y
            listener.positionZ.value = listenerPos.z
            listener.forwardX.value  = listenerFwd.x
            listener.forwardY.value  = listenerFwd.y
            listener.forwardZ.value  = listenerFwd.z
            listener.upX.value       = listenerUp.x
            listener.upY.value       = listenerUp.y
            listener.upZ.value       = listenerUp.z
        } else {
            try {
                listener.setPosition(listenerPos.x, listenerPos.y, listenerPos.z)
                listener.setOrientation(listenerFwd.x, listenerFwd.y, listenerFwd.z, listenerUp.x, listenerUp.y, listenerUp.z)
            } catch {}
        }

        if (!peers) return
        for (const [peerId, graph] of this.remoteGraphs) {
            const pos = peers.get?.(peerId)?.position
            if (!pos || !graph.panner) continue
            if (graph.panner.positionX) {
                graph.panner.positionX.value = pos.x
                graph.panner.positionY.value = pos.y
                graph.panner.positionZ.value = pos.z
            } else {
                try { graph.panner.setPosition(pos.x, pos.y, pos.z) } catch {}
            }
        }
    }

    applyFearDistortion(fearLevel = 0) {
        const fear = Math.max(0, Math.min(1, fearLevel))
        this._fearDistortionLevel = fear
        if (!this.remoteGraphs.size) return
        // Rebuilding the WaveShaper curve allocates — only when fear moves meaningfully
        if (this._lastCurveFear !== null && Math.abs(fear - this._lastCurveFear) < 0.05) return
        this._lastCurveFear = fear
        for (const graph of this.remoteGraphs.values()) {
            if (graph.distortion) graph.distortion.curve = this._makeDistortionCurve(fear)
        }
    }

    _makeDistortionCurve(amount) {
        const samples = 256
        const curve = new Float32Array(samples)
        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1
            curve[i] = amount < 0.1
                ? x
                : ((Math.PI + amount * 80) * x) / (Math.PI + amount * 80 * Math.abs(x))
        }
        return curve
    }

    _getAudioContext() {
        if (this.audioSystem?.ctx) return this.audioSystem.ctx
        if (!this._ownCtx) {
            try { this._ownCtx = new (window.AudioContext || window.webkitAudioContext)() } catch {}
        }
        return this._ownCtx ?? null
    }

    _closePeer(peerId, scheduleReconnect = true) {
        const pc = this.peerConnections.get(peerId)
        if (pc) { try { pc.close() } catch {} }
        this.peerConnections.delete(peerId)
        this._queuedIce.delete(peerId)

        const graph = this.remoteGraphs.get(peerId)
        if (graph) {
            try { graph.el?.pause(); if (graph.el) { graph.el.srcObject = null; graph.el.remove() } } catch {}
            try { graph.source.disconnect()      } catch {}
            try { graph.panner?.disconnect()     } catch {}
            try { graph.highpass?.disconnect()   } catch {}
            try { graph.filter.disconnect()      } catch {}
            try { graph.distortion?.disconnect() } catch {}
            try { graph.gain.disconnect()        } catch {}
            this.remoteGraphs.delete(peerId)
        }

        if (scheduleReconnect) this._scheduleReconnect(peerId)
    }
}
