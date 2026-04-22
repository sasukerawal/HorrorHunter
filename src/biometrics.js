// src/biometrics.js - Webcam pulse estimate using face ROI + green-channel autocorrelation.
// This is gameplay telemetry, not a medical measurement.

const SAMPLE_RATE = 15
const SAMPLE_INTERVAL = 1 / SAMPLE_RATE
const ESTIMATE_INTERVAL = 1.0
const FACE_DETECT_INTERVAL = 0.7
const BUFFER_SECONDS = 12
const MIN_ANALYSIS_SECONDS = 6
const MIN_BPM = 48
const MAX_BPM = 180

export class Biometrics {
    constructor() {
        this.videoEl = null
        this.stream = null
        this.available = false
        this.currentBPM = null
        this.confidence = 0

        this._sampleTimer = 0
        this._estimateTimer = 0
        this._detectTimer = 0
        this._detecting = false
        this._frameBuffer = []

        this._canvas = null
        this._canvasCtx = null
        this._faceDetector = null
        this._faceBox = null
        this._lastFaceSeen = 0
        this._lastValidBPM = null
    }

    async init() {
        try {
            this.videoEl = document.getElementById('biometric-cam')
            if (!this.videoEl) {
                this.videoEl = document.createElement('video')
                this.videoEl.id = 'biometric-cam'
                this.videoEl.style.display = 'none'
                this.videoEl.setAttribute('playsinline', '')
                this.videoEl.setAttribute('autoplay', '')
                document.body.appendChild(this.videoEl)
            }

            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('getUserMedia unavailable')
            }

            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user',
                    width: { ideal: 320 },
                    height: { ideal: 240 },
                    frameRate: { ideal: 30, max: 30 },
                },
                audio: false,
            })
            this.videoEl.srcObject = this.stream
            await this.videoEl.play()

            this._canvas = document.createElement('canvas')
            this._canvas.width = 96
            this._canvas.height = 72
            this._canvasCtx = this._canvas.getContext('2d', { willReadFrequently: true })

            if ('FaceDetector' in window) {
                try {
                    this._faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 })
                } catch {
                    this._faceDetector = null
                }
            }

            this.available = true
            this._setIndicator(this._faceDetector ? 'CAM SEARCH' : 'CAM ROI')
            return true
        } catch (err) {
            console.warn('[Biometrics] Camera access denied or unavailable:', err.message)
            this.available = false
            this._setIndicator('CAM OFF')
            return false
        }
    }

    update(dt) {
        if (!this.available || !this.videoEl || !this._canvasCtx) return
        if (this.videoEl.readyState < 2) return

        this._detectTimer += dt
        if (this._faceDetector && this._detectTimer >= FACE_DETECT_INTERVAL) {
            this._detectTimer = 0
            this._detectFace()
        }

        this._sampleTimer += dt
        if (this._sampleTimer < SAMPLE_INTERVAL) return
        this._sampleTimer = 0

        const sample = this._sampleFaceSignal()
        if (sample === null) return

        const now = performance.now() / 1000
        this._frameBuffer.push({ time: now, value: sample })
        const cutoff = now - BUFFER_SECONDS
        while (this._frameBuffer.length && this._frameBuffer[0].time < cutoff) {
            this._frameBuffer.shift()
        }

        this._estimateTimer += SAMPLE_INTERVAL
        if (this._estimateTimer >= ESTIMATE_INTERVAL) {
            this._estimateTimer = 0
            const estimate = this._estimateBPM()
            if (estimate) {
                this.currentBPM = estimate.bpm
                this.confidence = estimate.confidence
            }
            this._setIndicator(this._statusText())
        }
    }

    async _detectFace() {
        if (this._detecting || !this._faceDetector) return
        this._detecting = true
        try {
            const faces = await this._faceDetector.detect(this.videoEl)
            if (faces.length) {
                const box = faces[0].boundingBox
                const sx = this._canvas.width / (this.videoEl.videoWidth || 1)
                const sy = this._canvas.height / (this.videoEl.videoHeight || 1)

                const x = box.x * sx
                const y = box.y * sy
                const w = box.width * sx
                const h = box.height * sy

                this._faceBox = {
                    x: Math.max(0, x + w * 0.18),
                    y: Math.max(0, y + h * 0.22),
                    w: Math.max(8, w * 0.64),
                    h: Math.max(8, h * 0.48),
                }
                this._lastFaceSeen = performance.now()
            } else if (performance.now() - this._lastFaceSeen > 2000) {
                this._faceBox = null
            }
        } catch {
            this._faceDetector = null
            this._faceBox = null
        } finally {
            this._detecting = false
        }
    }

    _sampleFaceSignal() {
        const w = this._canvas.width
        const h = this._canvas.height
        this._canvasCtx.drawImage(this.videoEl, 0, 0, w, h)

        const roi = this._getROI(w, h)
        const x0 = Math.max(0, Math.floor(roi.x))
        const y0 = Math.max(0, Math.floor(roi.y))
        const x1 = Math.min(w, Math.ceil(roi.x + roi.w))
        const y1 = Math.min(h, Math.ceil(roi.y + roi.h))
        if (x1 <= x0 || y1 <= y0) return null

        const imageData = this._canvasCtx.getImageData(x0, y0, x1 - x0, y1 - y0)
        const data = imageData.data

        let rTotal = 0
        let gTotal = 0
        let bTotal = 0
        let count = 0
        let skinCount = 0

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i]
            const g = data[i + 1]
            const b = data[i + 2]
            const skinLike = r > 35 && g > 25 && b > 15 && r > b * 1.05 && g > b * 0.85
            if (skinLike) skinCount++
            if (!skinLike && skinCount > 12) continue

            rTotal += r
            gTotal += g
            bTotal += b
            count++
        }

        if (count < 20) return null
        const sum = rTotal + gTotal + bTotal
        if (sum <= 0) return null

        return gTotal / sum
    }

    _getROI(width, height) {
        if (this._faceBox) {
            return this._faceBox
        }

        return {
            x: width * 0.30,
            y: height * 0.18,
            w: width * 0.40,
            h: height * 0.46,
        }
    }

    _estimateBPM() {
        const samples = this._frameBuffer
        if (samples.length < SAMPLE_RATE * MIN_ANALYSIS_SECONDS) return null

        const start = samples[0].time
        const end = samples[samples.length - 1].time
        const duration = end - start
        if (duration < MIN_ANALYSIS_SECONDS) return null

        const resampled = this._resample(samples, SAMPLE_RATE)
        if (resampled.length < SAMPLE_RATE * MIN_ANALYSIS_SECONDS) return null

        const values = this._smooth(resampled)
        const mean = values.reduce((acc, value) => acc + value, 0) / values.length
        const centered = values.map(value => value - mean)
        const std = Math.sqrt(centered.reduce((acc, value) => acc + value * value, 0) / centered.length)
        if (std < 0.00001) return null

        for (let i = 0; i < centered.length; i++) centered[i] /= std

        const minLag = Math.ceil((60 / MAX_BPM) * SAMPLE_RATE)
        const maxLag = Math.floor((60 / MIN_BPM) * SAMPLE_RATE)

        let bestLag = 0
        let bestScore = -Infinity
        for (let lag = minLag; lag <= maxLag; lag++) {
            let score = 0
            let n = 0
            for (let i = lag; i < centered.length; i++) {
                score += centered[i] * centered[i - lag]
                n++
            }
            score = n ? score / n : -Infinity
            if (score > bestScore) {
                bestScore = score
                bestLag = lag
            }
        }

        if (!bestLag || bestScore < 0.12) return null

        let bpm = Math.round((60 * SAMPLE_RATE) / bestLag)
        if (this._lastValidBPM !== null) {
            const maxStep = 10
            const delta = Math.max(-maxStep, Math.min(maxStep, bpm - this._lastValidBPM))
            bpm = Math.round(this._lastValidBPM + delta)
            bpm = Math.round(this._lastValidBPM * 0.65 + bpm * 0.35)
        }

        bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, bpm))
        this._lastValidBPM = bpm

        return {
            bpm,
            confidence: Math.max(0, Math.min(1, bestScore)),
        }
    }

    _resample(samples, rate) {
        const result = []
        const step = 1 / rate
        let sampleIndex = 0
        for (let t = samples[0].time; t <= samples[samples.length - 1].time; t += step) {
            while (sampleIndex < samples.length - 2 && samples[sampleIndex + 1].time < t) {
                sampleIndex++
            }
            const a = samples[sampleIndex]
            const b = samples[Math.min(sampleIndex + 1, samples.length - 1)]
            const span = Math.max(0.0001, b.time - a.time)
            const mix = Math.max(0, Math.min(1, (t - a.time) / span))
            result.push(a.value + (b.value - a.value) * mix)
        }
        return result
    }

    _smooth(values) {
        const result = new Array(values.length)
        for (let i = 0; i < values.length; i++) {
            const prev = values[Math.max(0, i - 1)]
            const curr = values[i]
            const next = values[Math.min(values.length - 1, i + 1)]
            result[i] = (prev + curr * 2 + next) / 4
        }
        return result
    }

    _statusText() {
        if (!this.available) return 'CAM OFF'
        if (!this.currentBPM) return this._faceBox ? 'CAM FACE' : 'CAM SEARCH'
        const source = this._faceBox ? 'FACE' : 'ROI'
        const pct = Math.round(this.confidence * 100)
        return `CAM ${source} ${this.currentBPM} BPM ${pct}%`
    }

    _setIndicator(text) {
        const indicator = document.getElementById('bpm-source')
        if (indicator) indicator.textContent = text
    }

    getBPM() {
        return this.currentBPM
    }

    isAvailable() {
        return this.available
    }

    destroy() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop())
        }
        this.available = false
        this.currentBPM = null
        this.confidence = 0
        this._setIndicator('CAM OFF')
    }
}
