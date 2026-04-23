// src/voice.js — Native WebRTC proximity voice + prey panic cues for Hunter.

const VOICE_RANGE         = 42
const PANIC_RMS_THRESHOLD = 0.18
const PANIC_COOLDOWN      = 1.4
const RECONNECT_MAX_WAIT  = 16000   // ms — cap for exponential back-off

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
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
        this._micAttempted  = false
        this._queuedOffers  = []           // offers that arrived before mic was ready
        this._queuedIce     = new Map()    // peerId → RTCIceCandidate[]
        this._reconnectTimers = new Map()  // peerId → setTimeout handle
        this._reconnectDelay  = new Map()  // peerId → current back-off ms
        this.onPanicCue = null

        this._wireSignaling()
    }

    // ── PUBLIC ──────────────────────────────────────────────────────────────────

    async start(role, peers = []) {
        this.stop()
        this.role      = role
        this.peerRoles = new Map(peers.map(p => [p.id, p.role]))
        this._micAttempted = false

        console.log(`[Voice] Starting as ${role}; peers=${peers.map(p => `${p.id}:${p.role}`).join(', ') || 'none'}`)

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

    update(dt, peerDistance = Infinity, isLineOfSight = true) {
        this._updateRemoteVolumes(peerDistance, isLineOfSight)
        this._updateMicLevel(dt)
    }

    stop() {
        for (const handle of this._reconnectTimers.values()) clearTimeout(handle)
        this._reconnectTimers.clear()
        this._reconnectDelay.clear()

        for (const pc of this.peerConnections.values()) { try { pc.close() } catch {} }
        this.peerConnections.clear()

        for (const graph of this.remoteGraphs.values()) {
            try { graph.source.disconnect() } catch {}
            try { graph.filter.disconnect() } catch {}
            try { graph.gain.disconnect()   } catch {}
        }
        this.remoteGraphs.clear()

        this.localStream?.getTracks().forEach(t => t.stop())
        this.localStream  = null
        this.analyser     = null
        this.analyserData = null
        this._micAttempted = false
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

        this.socket.on('voicePanic', ({ fromId }) => {
            if (this.role !== 'hunter') return
            if (this.onPanicCue) this.onPanicCue(fromId)
        })

        this.socket.on('peerDisconnected', ({ id }) => {
            this._closePeer(id, false)
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
            iceServers:    ICE_SERVERS,
            bundlePolicy:  'max-bundle',
            rtcpMuxPolicy: 'require',
        })
        this.peerConnections.set(peerId, pc)

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
    }

    _setupRemoteGraph(peerId, stream) {
        if (this.remoteGraphs.has(peerId)) return
        const ctx         = this._getAudioContext()
        const destination = this.audioSystem?.masterGain ?? ctx?.destination
        if (!ctx || !destination) return
        if (ctx.state === 'suspended') ctx.resume()

        const source = ctx.createMediaStreamSource(stream)
        const filter = ctx.createBiquadFilter()
        const gain   = ctx.createGain()
        filter.type            = 'lowpass'
        filter.frequency.value = 7000
        gain.gain.value        = 0
        source.connect(filter)
        filter.connect(gain)
        gain.connect(destination)
        this.remoteGraphs.set(peerId, { source, filter, gain })
    }

    _updateRemoteVolumes(peerDistance, isLineOfSight) {
        if (!this.remoteGraphs.size) return
        const dist   = Number.isFinite(peerDistance) ? peerDistance : Infinity
        const base   = Math.max(0, Math.min(1, 1 - dist / VOICE_RANGE))
        const muffle = isLineOfSight ? 1 : 0.45
        const volume = Math.pow(base, 1.35) * muffle
        const freq   = isLineOfSight ? 7000 : 750
        const ctx    = this._getAudioContext()
        if (!ctx) return
        for (const graph of this.remoteGraphs.values()) {
            graph.gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.08)
            graph.filter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.08)
        }
    }

    _updateMicLevel(dt) {
        if (!this.analyser || !this.analyserData || this.role !== 'prey') return
        this._panicCooldown = Math.max(0, this._panicCooldown - dt)
        this._levelTimer += dt
        if (this._levelTimer < 0.08) return
        this._levelTimer = 0

        this.analyser.getByteTimeDomainData(this.analyserData)
        let sum = 0
        for (const v of this.analyserData) {
            const c = (v - 128) / 128
            sum += c * c
        }
        const rms = Math.sqrt(sum / this.analyserData.length)
        if (rms >= PANIC_RMS_THRESHOLD && this._panicCooldown <= 0) {
            this._panicCooldown = PANIC_COOLDOWN
            this.socket.emit('voicePanic', { level: rms })
        }
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
            try { graph.source.disconnect() } catch {}
            try { graph.filter.disconnect() } catch {}
            try { graph.gain.disconnect()   } catch {}
            this.remoteGraphs.delete(peerId)
        }

        if (scheduleReconnect) this._scheduleReconnect(peerId)
    }
}
