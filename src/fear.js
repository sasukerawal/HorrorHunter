// src/fear.js — Biometric Fear System
export class FearSystem {
    constructor() {
        this.baseBPM = 75
        this.currentBPM = 75
        this.currentFear = 0
        this.hunterDistance = Infinity
        this._bpmNoise = 0
        this._noiseTimer = 0
    }

    /** Called each frame with optional manual BPM override (debug slider) */
    update(dt, manualBPM = null) {
        this._noiseTimer += dt
        if (this._noiseTimer > 0.4) {
            this._bpmNoise = (Math.random() - 0.5) * 10
            this._noiseTimer = 0
        }

        if (manualBPM !== null) {
            this.currentBPM = manualBPM
        } else {
            // Proximity spike: closer hunter → higher BPM
            const proximitySurge = Math.max(0, 1 - this.hunterDistance / 12) * 60
            this.currentBPM = this.baseBPM + proximitySurge + this._bpmNoise
        }

        const bpmFactor = Math.max(0, (this.currentBPM - this.baseBPM) / 100)
        const emotionFactor = Math.max(0, 1 - this.hunterDistance / 12)

        this.currentFear = Math.min((bpmFactor * 0.7) + (emotionFactor * 0.3), 1)
        return this.currentFear
    }

    setHunterDistance(dist) {
        this.hunterDistance = dist
    }

    getGameplayModifiers() {
        return {
            flashlightFlicker: this.currentFear > 0.6,
            preySpeed: 1 + this.currentFear * 0.5,
            netAccuracy: 1 - this.currentFear * 0.4,
            dashEnabled: this.currentFear <= 0.8,
            footstepVolume: 0.2 + this.currentFear * 0.8
        }
    }

    getBPM() { return Math.round(this.currentBPM) }
    getFear() { return this.currentFear }

    /** Bloom = baseBloom + (fear * maxJitter) — used by NetGun + crosshair sizing */
    getBloom(baseBloom = 0.005, maxJitter = 0.18) {
        return baseBloom + this.currentFear * maxJitter
    }
}
