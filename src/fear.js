// src/fear.js — Biometric Fear System
//
// Fear uses a PRIORITY CASCADE — the highest-confidence source leads:
//
//   Tier 1 (BPM reliable, confidence ≥ 0.35):
//       fear = 0.55·BPM  + 0.25·Face  + 0.20·Proximity
//
//   Tier 2 (BPM unreliable, face emotion available):
//       fear = 0.55·Face + 0.25·Voice + 0.20·Proximity
//
//   Tier 3 (no BPM, no face, voice active):
//       fear = 0.55·Voice + 0.45·Proximity
//
//   Tier 4 (no biometrics at all):
//       fear = Proximity
//
// Bad BPM never drives gameplay — it falls through to the next tier.
// The active source name is available via getActiveSource() for the HUD.
export class FearSystem {
    constructor() {
        this.baseBPM = 75
        this.currentBPM = 75
        this.currentFear = 0
        this.hunterDistance = Infinity
        this._bpmNoise = 0
        this._noiseTimer = 0
        this._voiceFear = 0       // fed from voice.js
        this._activeSource = 'Proximity'   // last cascade tier that led fear
    }

    /**
     * @param {number}      dt
     * @param {number|null} manualBPM      — debug slider override (confidence = 1.0)
     * @param {number|null} biometricBPM   — from rPPG camera. null = unavailable.
     * @param {number|null} emotionFear    — 0..1 from MediaPipe blendshapes. null = no face.
     * @param {number}      bpmConfidence  — 0..1 autocorrelation quality from biometrics.js
     */
    update(dt, manualBPM = null, biometricBPM = null, emotionFear = null, bpmConfidence = 0) {
        this._noiseTimer += dt
        if (this._noiseTimer > 0.4) {
            this._bpmNoise = (Math.random() - 0.5) * 10
            this._noiseTimer = 0
        }

        const proximity01 = Math.max(0, 1 - this.hunterDistance / 12)

        // ── BPM computation: manual > biometric > proximity-simulated ──
        if (manualBPM !== null) {
            this.currentBPM = manualBPM
        } else if (biometricBPM !== null) {
            const proximitySurge = proximity01 * 30
            this.currentBPM = biometricBPM + proximitySurge + this._bpmNoise * 0.5
        } else {
            const proximitySurge = proximity01 * 60
            this.currentBPM = this.baseBPM + proximitySurge + this._bpmNoise
        }

        const bpmFactor = Math.max(0, (this.currentBPM - this.baseBPM) / 100)

        // Effective confidence: manual override is always trusted; biometric uses published score
        const effectiveConf = manualBPM !== null ? 1.0 : bpmConfidence
        const bpmAvailable  = biometricBPM !== null || manualBPM !== null

        // ── Priority cascade — highest-confidence source leads ──
        let fused, source
        if (bpmAvailable && effectiveConf >= 0.35) {
            // Tier 1: BPM reliable — leads with face/proximity support
            fused  = 0.55 * bpmFactor + 0.25 * (emotionFear ?? proximity01) + 0.20 * proximity01
            source = 'BPM'
        } else if (emotionFear !== null) {
            // Tier 2: BPM unreliable but face detected — face expression leads
            fused  = 0.55 * emotionFear + 0.25 * this._voiceFear + 0.20 * proximity01
            source = 'Face'
        } else if (this._voiceFear > 0.05) {
            // Tier 3: No camera data — sustained voice/breathing activity
            fused  = 0.55 * this._voiceFear + 0.45 * proximity01
            source = 'Voice'
        } else {
            // Tier 4: No biometrics — pure proximity
            fused  = proximity01
            source = 'Proximity'
        }

        this._activeSource = source

        // Temporal smoothing — fear rises/falls over ~0.4 s
        const SMOOTH = 0.85
        this.currentFear = this.currentFear * SMOOTH + Math.max(0, Math.min(1, fused)) * (1 - SMOOTH)
        return this.currentFear
    }

    setHunterDistance(dist) { this.hunterDistance = dist }

    /** Fed from voice.js — 0..1 based on RMS / breathing pattern */
    setVoiceFear(level) { this._voiceFear = Math.max(0, Math.min(1, level)) }

    getGameplayModifiers() {
        return {
            flashlightFlicker: this.currentFear > 0.6,
            preySpeed: 1 + this.currentFear * 0.5,
            netAccuracy: 1 - this.currentFear * 0.4,
            dashEnabled: this.currentFear <= 0.8,
            footstepVolume: 0.2 + this.currentFear * 0.8
        }
    }

    getBPM()          { return Math.round(this.currentBPM) }
    getFear()         { return this.currentFear }
    /** Which cascade tier is currently driving fear: 'BPM' | 'Face' | 'Voice' | 'Proximity' */
    getActiveSource() { return this._activeSource }

    /** Bloom = baseBloom + (fear * maxJitter) — used by NetGun + crosshair sizing */
    getBloom(baseBloom = 0.005, maxJitter = 0.18) {
        return baseBloom + this.currentFear * maxJitter
    }
}
