// src/biometrics.js — Camera-based rPPG Heart-Rate Estimator
//
// PIPELINE STAGES:
//   A. Camera frame capture — 96×72 px canvas for fast pixel reads.
//   B. Face detection — MediaPipe FaceLandmarker (GPU-delegated, CDN-loaded lazily)
//      provides precise forehead/cheek landmarks. Falls back to fixed centre ROI.
//   C. Skin-pixel classification — luminance + hue filter.
//   D. Chrominance signal — (R−G)/(R+G+B) per sample, EMA-smoothed.
//   E. Signal buffer — 15 seconds at 15 fps ≈ 225 samples.
//   F. BPM estimation —
//        1. Linear detrend (remove baseline drift)
//        2. Hann window (reduce spectral leakage)
//        3. Zero-mean + unit-variance normalisation
//        4. Normalised autocorrelation over BPM lag range
//        5. Parabolic interpolation around the peak lag (sub-sample precision)
//        6. Temporal smoothing + ±10 BPM/s rate limit

const SAMPLE_RATE          = 15
const SAMPLE_INTERVAL      = 1 / SAMPLE_RATE
const ESTIMATE_INTERVAL    = 1.0
const FACE_DETECT_INTERVAL = 0.40        // run MP every 0.4 s — good tracking, low overhead
const BUFFER_SECONDS       = 15          // more data → more stable autocorrelation
const MIN_ANALYSIS_SECONDS = 6
const MIN_BPM              = 48
const MAX_BPM              = 180
const SMOOTH_ALPHA         = 0.85
const CONFIDENCE_THRESHOLD = 0.12        // slightly lower than 0.15 — more estimates accepted

// MediaPipe CDN (pinned to a stable release)
const MP_CDN   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17'
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// Landmark indices chosen for forehead centre + bilateral cheeks
// (numbers per MediaPipe Face Mesh 478-point topology)
const FACE_ROI_LANDMARKS = [10, 9, 8, 107, 336, 116, 147, 187, 207, 345, 376, 411, 427]

// ROI temporal smoothing — how fast the tracked box follows the face
const ROI_SMOOTH = 0.35   // 0=instant, 1=frozen; lower = follows faster

export class Biometrics {
    constructor() {
        this.videoEl    = null
        this.stream     = null
        this.available  = false
        this.currentBPM = null
        this.confidence = 0

        this._sampleTimer   = 0
        this._estimateTimer = 0
        this._detectTimer   = 0
        this._frameBuffer   = []
        this._smoothedSignal = null

        this._canvas    = null
        this._canvasCtx = null
        this._faceBox      = null         // current smoothed ROI {x, y, w, h}
        this._rawFaceBox   = null         // last raw landmark box before smoothing
        this._lastFaceSeen = 0
        this._lastValidBPM = null

        this._faceLandmarker      = null
        this._faceLandmarkerReady = false
    }

    // ── PUBLIC ─────────────────────────────────────────────────────────────────

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

            if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable')

            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user',
                    width:     { ideal: 320 },
                    height:    { ideal: 240 },
                    frameRate: { ideal: 30, max: 30 },
                },
                audio: false,
            })
            this.videoEl.srcObject = this.stream
            await this.videoEl.play()

            this._canvas        = document.createElement('canvas')
            this._canvas.width  = 96
            this._canvas.height = 72
            this._canvasCtx = this._canvas.getContext('2d', { willReadFrequently: true })

            this.available = true
            this._setIndicator('CAM ROI — LOADING FACE AI…')

            // Fire-and-forget: rPPG starts with fixed ROI immediately and upgrades
            // to precise landmark tracking once the model downloads (~5 MB).
            this._initMediaPipe()

            return true
        } catch (err) {
            console.warn('[Biometrics] Camera unavailable:', err.message)
            this.available = false
            this._setIndicator('CAM OFF')
            return false
        }
    }

    update(dt) {
        if (!this.available || !this.videoEl || !this._canvasCtx) return
        if (this.videoEl.readyState < 2) return

        // ── Stage B: face detection at a fixed interval ──
        this._detectTimer += dt
        if (this._detectTimer >= FACE_DETECT_INTERVAL) {
            this._detectTimer = 0
            this._detectFace()
        }

        // ── Stage C+D: sample at SAMPLE_RATE ──
        this._sampleTimer += dt
        if (this._sampleTimer < SAMPLE_INTERVAL) return
        this._sampleTimer = 0

        const raw = this._sampleFaceSignal()
        if (raw === null) return

        this._smoothedSignal = this._smoothedSignal === null
            ? raw
            : SMOOTH_ALPHA * this._smoothedSignal + (1 - SMOOTH_ALPHA) * raw

        const now = performance.now() / 1000
        this._frameBuffer.push({ time: now, value: this._smoothedSignal })

        const cutoff = now - BUFFER_SECONDS
        while (this._frameBuffer.length && this._frameBuffer[0].time < cutoff) {
            this._frameBuffer.shift()
        }

        // ── Stage F: periodic BPM estimation ──
        this._estimateTimer += SAMPLE_INTERVAL
        if (this._estimateTimer >= ESTIMATE_INTERVAL) {
            this._estimateTimer = 0
            const est = this._estimateBPM()
            if (est) {
                this.currentBPM = est.bpm
                this.confidence = est.confidence
            }
            this._setIndicator(this._statusText())
        }
    }

    getBPM()       { return this.currentBPM }
    isAvailable()  { return this.available  }

    destroy() {
        this.stream?.getTracks().forEach(t => t.stop())
        try { this._faceLandmarker?.close() } catch {}
        this._faceLandmarker      = null
        this._faceLandmarkerReady = false
        this.available  = false
        this.currentBPM = null
        this.confidence = 0
        this._setIndicator('CAM OFF')
    }

    // ── PRIVATE — MEDIAPIPE INIT ────────────────────────────────────────────────

    async _initMediaPipe() {
        try {
            const { FaceLandmarker, FilesetResolver } = await import(`${MP_CDN}/vision_bundle.mjs`)
            const vision = await FilesetResolver.forVisionTasks(`${MP_CDN}/wasm`)
            this._faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: MP_MODEL,
                    delegate: 'GPU',
                },
                runningMode: 'VIDEO',
                numFaces: 1,
                outputFaceBlendshapes: false,
                outputFacialTransformationMatrixes: false,
            })
            this._faceLandmarkerReady = true
            console.log('[Biometrics] MediaPipe FaceLandmarker ready')
            this._setIndicator('CAM FACE LOCK — CALIBRATING…')
        } catch (err) {
            console.warn('[Biometrics] MediaPipe unavailable (fixed ROI fallback):', err.message)
            this._faceLandmarkerReady = false
        }
    }

    // ── PRIVATE — STAGE B: FACE DETECTION ─────────────────────────────────────

    _detectFace() {
        if (!this._faceLandmarkerReady || !this._faceLandmarker) return
        if (this.videoEl.readyState < 2) return
        try {
            const results   = this._faceLandmarker.detectForVideo(this.videoEl, performance.now())
            const landmarks = results.faceLandmarks?.[0]
            if (landmarks) {
                const raw = this._landmarksToBox(landmarks)
                if (raw) {
                    this._rawFaceBox = raw
                    this._lastFaceSeen = performance.now()
                    // Temporal smoothing: lerp existing box toward new detection
                    if (!this._faceBox) {
                        this._faceBox = { ...raw }
                    } else {
                        this._faceBox.x = this._faceBox.x * ROI_SMOOTH + raw.x * (1 - ROI_SMOOTH)
                        this._faceBox.y = this._faceBox.y * ROI_SMOOTH + raw.y * (1 - ROI_SMOOTH)
                        this._faceBox.w = this._faceBox.w * ROI_SMOOTH + raw.w * (1 - ROI_SMOOTH)
                        this._faceBox.h = this._faceBox.h * ROI_SMOOTH + raw.h * (1 - ROI_SMOOTH)
                    }
                }
            } else if (performance.now() - this._lastFaceSeen > 2500) {
                this._faceBox    = null
                this._rawFaceBox = null
            }
        } catch (err) {
            console.warn('[Biometrics] FaceLandmarker detect error:', err.message)
            this._faceLandmarkerReady = false
            this._faceBox    = null
            this._rawFaceBox = null
        }
    }

    _landmarksToBox(landmarks) {
        const w = this._canvas.width
        const h = this._canvas.height
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const idx of FACE_ROI_LANDMARKS) {
            const lm = landmarks[idx]
            if (!lm) continue
            const px = lm.x * w
            const py = lm.y * h
            if (px < minX) minX = px
            if (py < minY) minY = py
            if (px > maxX) maxX = px
            if (py > maxY) maxY = py
        }
        if (!Number.isFinite(minX)) return null
        const pad = 3
        return {
            x: Math.max(0, minX - pad),
            y: Math.max(0, minY - pad),
            w: Math.max(8, maxX - minX + pad * 2),
            h: Math.max(8, maxY - minY + pad * 2),
        }
    }

    // ── PRIVATE — STAGE C+D: PIXEL SAMPLING ───────────────────────────────────

    _sampleFaceSignal() {
        const w = this._canvas.width
        const h = this._canvas.height
        this._canvasCtx.drawImage(this.videoEl, 0, 0, w, h)

        const roi = this._getROI(w, h)
        const x0  = Math.max(0, Math.floor(roi.x))
        const y0  = Math.max(0, Math.floor(roi.y))
        const x1  = Math.min(w, Math.ceil(roi.x + roi.w))
        const y1  = Math.min(h, Math.ceil(roi.y + roi.h))
        if (x1 <= x0 || y1 <= y0) return null

        const { data } = this._canvasCtx.getImageData(x0, y0, x1 - x0, y1 - y0)
        let rSum = 0, gSum = 0, bSum = 0, count = 0

        for (let i = 0; i < data.length; i += 16) {  // step=16 → every 4th pixel
            const r = data[i], g = data[i + 1], b = data[i + 2]
            const lum = 0.299 * r + 0.587 * g + 0.114 * b
            if (lum < 30 || lum > 230) continue
            if (r < 50 || r < b)        continue
            if (g > r || b > r * 0.85)  continue
            rSum += r; gSum += g; bSum += b
            count++
        }

        if (count < 15) return null
        const total = rSum + gSum + bSum
        return total > 0 ? (rSum - gSum) / total : null
    }

    _getROI(width, height) {
        if (this._faceBox) return this._faceBox
        return { x: width * 0.28, y: height * 0.12, w: width * 0.44, h: height * 0.55 }
    }

    // ── PRIVATE — STAGE F: BPM ESTIMATION VIA AUTOCORRELATION ────────────────

    _estimateBPM() {
        const samples = this._frameBuffer
        if (samples.length < SAMPLE_RATE * MIN_ANALYSIS_SECONDS) return null

        const duration = samples[samples.length - 1].time - samples[0].time
        if (duration < MIN_ANALYSIS_SECONDS) return null

        // 1. Uniform resample
        const uniform = this._resample(samples, SAMPLE_RATE)
        if (uniform.length < SAMPLE_RATE * MIN_ANALYSIS_SECONDS) return null

        // 2. Linear detrend — removes slow baseline drift before windowing
        const detrended = this._detrend(uniform)

        // 3. Hann window
        const windowed = this._applyHannWindow(detrended)

        // 4. Zero-mean + unit-variance normalisation
        const mean     = windowed.reduce((a, v) => a + v, 0) / windowed.length
        const centred  = windowed.map(v => v - mean)
        const variance = centred.reduce((a, v) => a + v * v, 0) / centred.length
        const std      = Math.sqrt(variance)
        if (std < 0.000005) return null
        const normed = centred.map(v => v / std)

        // 5. Normalised autocorrelation
        const lagMin = Math.ceil((60 / MAX_BPM) * SAMPLE_RATE)
        const lagMax = Math.floor((60 / MIN_BPM) * SAMPLE_RATE)

        const scores = new Float32Array(lagMax + 1)
        let bestLag = 0, bestScore = -Infinity
        for (let lag = lagMin; lag <= lagMax; lag++) {
            let s = 0, n = 0
            for (let i = lag; i < normed.length; i++) {
                s += normed[i] * normed[i - lag]
                n++
            }
            scores[lag] = n ? s / n : -Infinity
            if (scores[lag] > bestScore) { bestScore = scores[lag]; bestLag = lag }
        }

        if (!bestLag || bestScore < CONFIDENCE_THRESHOLD) return null

        // 6. Parabolic interpolation — sub-lag peak precision
        let exactLag = bestLag
        if (bestLag > lagMin && bestLag < lagMax) {
            const y0 = scores[bestLag - 1]
            const y1 = scores[bestLag]
            const y2 = scores[bestLag + 1]
            const denom = y0 - 2 * y1 + y2
            if (Math.abs(denom) > 1e-10) {
                exactLag = bestLag + 0.5 * (y0 - y2) / denom
            }
        }

        let bpm = Math.round((60 * SAMPLE_RATE) / exactLag)

        // 7. Temporal smoothing + rate limit
        if (this._lastValidBPM !== null) {
            const maxStep = 10
            const delta   = Math.max(-maxStep, Math.min(maxStep, bpm - this._lastValidBPM))
            bpm = Math.round(this._lastValidBPM * 0.65 + (this._lastValidBPM + delta) * 0.35)
        }

        bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, bpm))
        this._lastValidBPM = bpm

        return { bpm, confidence: Math.max(0, Math.min(1, bestScore)) }
    }

    // ── PRIVATE — HELPERS ──────────────────────────────────────────────────────

    _resample(samples, rate) {
        const result = []
        const step   = 1 / rate
        let si = 0
        for (let t = samples[0].time; t <= samples[samples.length - 1].time; t += step) {
            while (si < samples.length - 2 && samples[si + 1].time < t) si++
            const a    = samples[si]
            const b    = samples[Math.min(si + 1, samples.length - 1)]
            const span = Math.max(0.0001, b.time - a.time)
            const mix  = Math.max(0, Math.min(1, (t - a.time) / span))
            result.push(a.value + (b.value - a.value) * mix)
        }
        return result
    }

    /** Remove linear trend (least-squares line fit and subtract) */
    _detrend(values) {
        const n = values.length
        if (n < 2) return values
        let sx = 0, sy = 0, sxx = 0, sxy = 0
        for (let i = 0; i < n; i++) {
            sx  += i
            sy  += values[i]
            sxx += i * i
            sxy += i * values[i]
        }
        const denom = n * sxx - sx * sx
        if (Math.abs(denom) < 1e-10) return values
        const slope     = (n * sxy - sx * sy) / denom
        const intercept = (sy - slope * sx) / n
        return values.map((v, i) => v - (slope * i + intercept))
    }

    _applyHannWindow(values) {
        const N = values.length
        return values.map((v, i) => v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))))
    }

    _statusText() {
        if (!this.available) return 'CAM OFF'
        if (!this.currentBPM) {
            if (this._faceLandmarkerReady && this._faceBox) return 'CAM FACE LOCK — CALIBRATING…'
            return this._faceLandmarkerReady ? 'CAM MP — SEARCHING…' : 'CAM ROI — CALIBRATING…'
        }
        const src = this._faceLandmarkerReady && this._faceBox ? 'MP' : 'ROI'
        return `PULSE ${this.currentBPM} BPM [${src} ${Math.round(this.confidence * 100)}%]`
    }

    _setIndicator(text) {
        const el = document.getElementById('bpm-source')
        if (el) el.textContent = text
    }
}
