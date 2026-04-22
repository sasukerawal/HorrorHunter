// src/audio.js — Web Audio API Spatial Sound System + Peer Spatial Audio
export class AudioSystem {
    constructor() {
        this.ctx = null
        this.masterGain = null
        this.footstepTimer = 0
        this.heartbeatTimer = 0
        this.heartbeatInterval = 0.8
        this.enabled = false

        // Peer spatial audio
        this._peerGain = null
        this._peerFilter = null
        this._peerOsc = null
        this._peerStepTimer = 0
    }

    init() {
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)()
            this.masterGain = this.ctx.createGain()
            this.masterGain.gain.value = 0.4
            this.masterGain.connect(this.ctx.destination)
            this.enabled = true
        } catch (e) {
            console.warn('[Audio] Web Audio API not available:', e)
        }
    }

    _resume() {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume()
    }

    // ─── LOCAL PLAYER SOUNDS ───

    playFootstep(volume = 0.3) {
        if (!this.enabled) return
        this._resume()
        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(80, this.ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.1)
        gain.gain.setValueAtTime(volume, this.ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.1)
        osc.connect(gain)
        gain.connect(this.masterGain)
        osc.start()
        osc.stop(this.ctx.currentTime + 0.1)
    }

    playHeartbeat(fearLevel = 0) {
        if (!this.enabled) return
        this._resume()
        const vol = 0.15 + fearLevel * 0.45
        const playBeat = (offset, freq) => {
            const osc = this.ctx.createOscillator()
            const gain = this.ctx.createGain()
            osc.type = 'sine'
            osc.frequency.value = freq
            gain.gain.setValueAtTime(vol, this.ctx.currentTime + offset)
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + offset + 0.12)
            osc.connect(gain)
            gain.connect(this.masterGain)
            osc.start(this.ctx.currentTime + offset)
            osc.stop(this.ctx.currentTime + offset + 0.12)
        }
        playBeat(0, 55)
        playBeat(0.13, 48)
    }

    playNetFire() {
        if (!this.enabled) return
        this._resume()
        const bufferSize = this.ctx.sampleRate * 0.08
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate)
        const data = buffer.getChannelData(0)
        for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1)
        const noise = this.ctx.createBufferSource()
        noise.buffer = buffer
        const noiseFilter = this.ctx.createBiquadFilter()
        noiseFilter.type = 'bandpass'
        noiseFilter.frequency.value = 800
        const noiseGain = this.ctx.createGain()
        noiseGain.gain.setValueAtTime(0.5, this.ctx.currentTime)
        noiseGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08)
        noise.connect(noiseFilter)
        noiseFilter.connect(noiseGain)
        noiseGain.connect(this.masterGain)
        noise.start()

        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(600, this.ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + 0.15)
        gain.gain.setValueAtTime(0.3, this.ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15)
        osc.connect(gain)
        gain.connect(this.masterGain)
        osc.start()
        osc.stop(this.ctx.currentTime + 0.15)
    }

    playNetHit() {
        if (!this.enabled) return
        this._resume()
        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        osc.type = 'square'
        osc.frequency.setValueAtTime(200, this.ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(50, this.ctx.currentTime + 0.3)
        gain.gain.setValueAtTime(0.6, this.ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3)
        osc.connect(gain)
        gain.connect(this.masterGain)
        osc.start()
        osc.stop(this.ctx.currentTime + 0.3)
    }

    startAmbientDrone() {
        if (!this.enabled) return
        this._resume()
        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = 55
        gain.gain.value = 0.08
        const tremolo = this.ctx.createOscillator()
        const tremoloGain = this.ctx.createGain()
        tremolo.frequency.value = 0.25
        tremoloGain.gain.value = 0.04
        tremolo.connect(tremoloGain)
        tremoloGain.connect(gain.gain)
        osc.connect(gain)
        gain.connect(this.masterGain)
        osc.start()
        tremolo.start()
    }

    playGameOver(winner) {
        if (!this.enabled) return
        this._resume()
        const freqs = winner === 'hunter'
            ? [440, 554, 659, 880]
            : [220, 185, 165, 140]
        freqs.forEach((freq, i) => {
            const osc = this.ctx.createOscillator()
            const gain = this.ctx.createGain()
            osc.type = 'sine'
            osc.frequency.value = freq
            gain.gain.setValueAtTime(0, this.ctx.currentTime + i * 0.15)
            gain.gain.linearRampToValueAtTime(0.3, this.ctx.currentTime + i * 0.15 + 0.05)
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + i * 0.15 + 0.8)
            osc.connect(gain)
            gain.connect(this.masterGain)
            osc.start(this.ctx.currentTime + i * 0.15)
            osc.stop(this.ctx.currentTime + i * 0.15 + 0.8)
        })
    }

    // Door creak sound
    playDoorCreak() {
        if (!this.enabled) return
        this._resume()
        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(120, this.ctx.currentTime)
        osc.frequency.linearRampToValueAtTime(80, this.ctx.currentTime + 0.6)
        osc.frequency.linearRampToValueAtTime(150, this.ctx.currentTime + 1.0)
        gain.gain.setValueAtTime(0.15, this.ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 1.0)
        const filter = this.ctx.createBiquadFilter()
        filter.type = 'lowpass'
        filter.frequency.value = 400
        osc.connect(filter)
        filter.connect(gain)
        gain.connect(this.masterGain)
        osc.start()
        osc.stop(this.ctx.currentTime + 1.0)
    }

    // Heavy spatial "thud" played alongside the creak when a door is toggled.
    // distance: optional — attenuates the thud if the listener is farther from the door
    playDoorThud(distance = 0) {
        if (!this.enabled) return
        this._resume()
        const attenuation = Math.max(0.25, 1 - Math.min(1, distance / 12))
        const now = this.ctx.currentTime

        // Filtered noise burst — the slam impact
        const bufferSize = this.ctx.sampleRate * 0.18
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate)
        const data = buffer.getChannelData(0)
        for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize)
        const noise = this.ctx.createBufferSource()
        noise.buffer = buffer
        const noiseFilter = this.ctx.createBiquadFilter()
        noiseFilter.type = 'lowpass'
        noiseFilter.frequency.value = 250
        const noiseGain = this.ctx.createGain()
        noiseGain.gain.setValueAtTime(0.45 * attenuation, now)
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18)
        noise.connect(noiseFilter)
        noiseFilter.connect(noiseGain)
        noiseGain.connect(this.masterGain)
        noise.start(now)

        // Sub-thump
        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(85, now)
        osc.frequency.exponentialRampToValueAtTime(35, now + 0.18)
        gain.gain.setValueAtTime(0.55 * attenuation, now)
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22)
        osc.connect(gain)
        gain.connect(this.masterGain)
        osc.start(now)
        osc.stop(now + 0.22)
    }

    // ─── HP FEEDBACK SOUNDS ───

    playDamageTaken() {
        if (!this.enabled) return
        this._resume()
        // Low distortion hit
        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        const dist = this.ctx.createWaveShaperFunction ? null : null
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(120, this.ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.25)
        gain.gain.setValueAtTime(0.6, this.ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.25)
        const filter = this.ctx.createBiquadFilter()
        filter.type = 'lowpass'
        filter.frequency.value = 300
        osc.connect(filter)
        filter.connect(gain)
        gain.connect(this.masterGain)
        osc.start()
        osc.stop(this.ctx.currentTime + 0.25)
    }

    playHealthPickup() {
        if (!this.enabled) return
        this._resume()
        // Bright ascending chime
        const freqs = [523, 659, 784]
        freqs.forEach((freq, i) => {
            const osc = this.ctx.createOscillator()
            const gain = this.ctx.createGain()
            osc.type = 'sine'
            osc.frequency.value = freq
            gain.gain.setValueAtTime(0, this.ctx.currentTime + i * 0.08)
            gain.gain.linearRampToValueAtTime(0.25, this.ctx.currentTime + i * 0.08 + 0.03)
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + i * 0.08 + 0.3)
            osc.connect(gain)
            gain.connect(this.masterGain)
            osc.start(this.ctx.currentTime + i * 0.08)
            osc.stop(this.ctx.currentTime + i * 0.08 + 0.3)
        })
    }

    // ─── PEER SPATIAL AUDIO (The Stalker Effect) ───

    /** Call once per frame: play a distance-attenuated heavy thud for the peer */
    playPeerFootstep(peerDistance, isLineOfSight) {
        if (!this.enabled) return
        if (peerDistance > 15) return // too far, no sound at all
        this._resume()

        // Volume scales inversely with distance, muffles if occluded
        let vol = Math.max(0, Math.min(0.7, 1.0 - peerDistance / 15)) * 0.5
        if (!isLineOfSight) vol *= 0.4

        const osc = this.ctx.createOscillator()
        const gain = this.ctx.createGain()
        const filter = this.ctx.createBiquadFilter()

        // Heavy, low-pass filtered square-wave thud (hunter = menacing)
        osc.type = 'square'
        osc.frequency.setValueAtTime(50, this.ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(25, this.ctx.currentTime + 0.15)

        filter.type = 'lowpass'
        filter.frequency.value = isLineOfSight ? 2000 : 400

        gain.gain.setValueAtTime(vol, this.ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15)

        osc.connect(filter)
        filter.connect(gain)
        gain.connect(this.masterGain)
        osc.start()
        osc.stop(this.ctx.currentTime + 0.15)
    }

    // ─── MAIN UPDATE ───

    update(dt, fearLevel, isMoving, bpm, peerDistance = Infinity, isLineOfSight = true) {
        if (!this.enabled) return

        // Local footsteps
        const stepInterval = isMoving ? Math.max(0.25, 0.5 - fearLevel * 0.2) : Infinity
        this.footstepTimer += dt
        if (this.footstepTimer >= stepInterval) {
            this.footstepTimer = 0
            this.playFootstep(0.2 + fearLevel * 0.4)
        }

        // Heartbeat
        this.heartbeatInterval = 60 / Math.max(bpm, 40)
        this.heartbeatTimer += dt
        if (this.heartbeatTimer >= this.heartbeatInterval) {
            this.heartbeatTimer = 0
            this.playHeartbeat(fearLevel)
        }

        // Peer spatial footsteps — heavy thuds at the peer's distance
        if (peerDistance < 15) {
            const peerStepRate = Math.max(0.3, 0.6 - (1 - peerDistance / 15) * 0.3)
            this._peerStepTimer += dt
            if (this._peerStepTimer >= peerStepRate) {
                this._peerStepTimer = 0
                this.playPeerFootstep(peerDistance, isLineOfSight)
            }
        }
    }

    setMasterVolume(v) {
        if (this.masterGain) this.masterGain.gain.value = v
    }
}
