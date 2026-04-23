// src/voice.js - Native WebRTC proximity voice, plus Prey panic cues for Hunter.

const VOICE_RANGE = 42
const PANIC_RMS_THRESHOLD = 0.18
const PANIC_COOLDOWN = 1.4

export class VoiceChat {
    constructor(socket, audioSystem = null) {
        this.socket = socket
        this.audioSystem = audioSystem
        this.role = null
        this.peerRoles = new Map()
        this.localStream = null
        this.peerConnections = new Map()
        this.remoteGraphs = new Map()
        this.analyser = null
        this.analyserData = null
        this._ownCtx = null
        this._panicCooldown = 0
        this._levelTimer = 0
        this._micAttempted = false
        this._queuedOffers = []
        this._queuedIce = new Map()
        this.onPanicCue = null

        this._wireSignaling()
    }

    async start(role, peers = []) {
        this.stop()
        this.role = role
        this.peerRoles = new Map(peers.map(peer => [peer.id, peer.role]))
        this._micAttempted = false
        console.log(`[Voice] Starting as ${role}; peers=${peers.map(p => `${p.id}:${p.role}`).join(', ') || 'none'}`)

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
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
        for (const pc of this.peerConnections.values()) pc.close()
        this.peerConnections.clear()
        for (const graph of this.remoteGraphs.values()) {
            try { graph.source.disconnect() } catch {}
            try { graph.filter.disconnect() } catch {}
            try { graph.gain.disconnect() } catch {}
        }
        this.remoteGraphs.clear()
        this.localStream?.getTracks().forEach(track => track.stop())
        this.localStream = null
        this.analyser = null
        this.analyserData = null
        this._micAttempted = false
    }

    _wireSignaling() {
        this.socket.on('voiceOffer', async ({ fromId, description }) => {
            console.log(`[Voice] offer from ${fromId}`)
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
            }
        })

        this.socket.on('voiceIceCandidate', async ({ fromId, candidate }) => {
            const pc = this.peerConnections.get(fromId)
            if (!candidate) return
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
            this._closePeer(id)
        })
    }

    async _handleVoiceOffer({ fromId, description }) {
        if (!description) return
        if (!this.role) {
            this._queuedOffers.push({ fromId, description })
            return
        }
        if (!this.localStream && !this._micAttempted) {
            this._queuedOffers.push({ fromId, description })
            return
        }
        try {
            const pc = this._connectPeer(fromId, false)
            await pc.setRemoteDescription(description)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            this.socket.emit('voiceAnswer', { targetId: fromId, description: pc.localDescription })
            await this._flushQueuedIce(fromId)
            console.log(`[Voice] answer sent to ${fromId}`)
        } catch (err) {
            console.warn('[Voice] Offer handling failed:', err.message)
            this._closePeer(fromId)
        }
    }

    _shouldInitiate(peerId) {
        return String(this.socket.id || '') < String(peerId || '')
    }

    _connectPeer(peerId, initiate) {
        if (this.peerConnections.has(peerId)) return this.peerConnections.get(peerId)

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        })
        this.peerConnections.set(peerId, pc)
        console.log(`[Voice] peer connection created for ${peerId}`)

        for (const track of this.localStream?.getTracks() ?? []) {
            pc.addTrack(track, this.localStream)
        }
        if (!this.localStream?.getAudioTracks().length) {
            pc.addTransceiver('audio', { direction: 'recvonly' })
        }

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('voiceIceCandidate', { targetId: peerId, candidate: event.candidate })
            }
        }

        pc.ontrack = (event) => {
            const [stream] = event.streams
            console.log(`[Voice] remote track from ${peerId}`)
            if (stream) this._setupRemoteGraph(peerId, stream)
        }

        pc.onconnectionstatechange = () => {
            console.log(`[Voice] ${peerId} state=${pc.connectionState}`)
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
                this._closePeer(peerId)
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
                }
            })
        }

        return pc
    }

    _queueIce(peerId, candidate) {
        if (!this._queuedIce.has(peerId)) this._queuedIce.set(peerId, [])
        this._queuedIce.get(peerId).push(candidate)
    }

    async _flushQueuedIce(peerId) {
        const pc = this.peerConnections.get(peerId)
        const queued = this._queuedIce.get(peerId)
        if (!pc || !pc.remoteDescription || !queued?.length) return
        this._queuedIce.delete(peerId)
        for (const candidate of queued) {
            try {
                await pc.addIceCandidate(candidate)
            } catch (err) {
                console.warn('[Voice] Queued ICE rejected:', err.message)
            }
        }
    }

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
        const ctx = this._getAudioContext()
        const destination = this.audioSystem?.masterGain ?? ctx?.destination
        if (!ctx || !destination) return
        if (ctx.state === 'suspended') ctx.resume()

        const source = ctx.createMediaStreamSource(stream)
        const filter = ctx.createBiquadFilter()
        const gain = ctx.createGain()
        filter.type = 'lowpass'
        filter.frequency.value = 7000
        gain.gain.value = 0
        source.connect(filter)
        filter.connect(gain)
        gain.connect(destination)
        this.remoteGraphs.set(peerId, { source, filter, gain })
        console.log(`[Voice] remote audio graph ready for ${peerId}`)
    }

    _updateRemoteVolumes(peerDistance, isLineOfSight) {
        if (!this.remoteGraphs.size) return
        const dist = Number.isFinite(peerDistance) ? peerDistance : Infinity
        const base = Math.max(0, Math.min(1, 1 - dist / VOICE_RANGE))
        const muffled = isLineOfSight ? 1 : 0.45
        const volume = Math.pow(base, 1.35) * muffled
        const filterFreq = isLineOfSight ? 7000 : 750

        for (const graph of this.remoteGraphs.values()) {
            const ctx = this._getAudioContext()
            graph.gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.08)
            graph.filter.frequency.setTargetAtTime(filterFreq, ctx.currentTime, 0.08)
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
        for (const value of this.analyserData) {
            const centered = (value - 128) / 128
            sum += centered * centered
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
            try {
                this._ownCtx = new (window.AudioContext || window.webkitAudioContext)()
            } catch {
                this._ownCtx = null
            }
        }
        return this._ownCtx
    }

    _closePeer(peerId) {
        const pc = this.peerConnections.get(peerId)
        if (pc) pc.close()
        this.peerConnections.delete(peerId)
        this._queuedIce.delete(peerId)

        const graph = this.remoteGraphs.get(peerId)
        if (graph) {
            try { graph.source.disconnect() } catch {}
            try { graph.filter.disconnect() } catch {}
            try { graph.gain.disconnect() } catch {}
        }
        this.remoteGraphs.delete(peerId)
    }
}
