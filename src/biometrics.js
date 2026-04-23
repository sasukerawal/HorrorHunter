// src/biometrics.js — Camera-based rPPG Heart-Rate Estimator
//
// HOW IT WORKS (detailed explanation):
// ─────────────────────────────────────────────────────────────────────────────
// Remote Photoplethysmography (rPPG) uses an ordinary webcam to detect your
// pulse by exploiting the same principle as a pulse-oximeter:
//   1. Blood is red/absorbs green light differently depending on how much
//      oxygenated haemoglobin is present at any instant.
//   2. With every heartbeat the vessels in your face dilate slightly, momentarily
//      changing the skin's colour by a tiny but measurable amount.
//   3. By averaging the colour of a large patch of your forehead/cheeks over
//      time and filtering the resulting signal, we can recover the underlying
//      cardiac waveform (typically 48–180 BPM).
//
// PIPELINE STAGES:
//   A. Camera frame capture — we resize the video to a small canvas (96×72 px)
//      for speed and privacy.
//   B. Face detection — uses MediaPipe FaceLandmarker (loaded lazily from CDN)
//      when available; falls back to a fixed centre ROI otherwise.
//   C. Skin-pixel classification — we skip pixels that don't look like skin
//      (luminance too low/high, wrong hue), reducing noise from background.
//   D. Chrominance pulse signal extraction — we compute
//         signal = (R - G) / (R + G + B)
//      This ratio is largely illumination-invariant: overall brightness changes
//      cancel in the division, leaving only the tiny colour variation from the
//      heartbeat.  We smooth it with an exponential moving average (α=0.85) to
//      suppress single-frame noise.
//   E. Signal buffer — we keep 12 seconds of smoothed samples at ~15 fps,
//      giving ~180 samples — enough for reliable autocorrelation above 48 BPM.
//   F. BPM estimation (normalised autocorrelation) —
//      * Subtract the mean and divide by std-dev (stationarises the signal).
//      * Compute the autocorrelation at each lag L ∈ [lagMin, lagMax] where
//          lagMin = floor( sampleRate × 60/maxBPM )
//          lagMax = floor( sampleRate × 60/minBPM )
//      * The lag with the highest autocorrelation corresponds to one heartbeat
//        period, from which BPM = 60 × sampleRate / bestLag.
//      * A Hann window is applied to the signal before correlation to reduce
//        spectral leakage from signal boundaries.
//      * The result is temporally smoothed (weighted 35/65 blend with the
//        previous valid estimate) and clamped to ±10 BPM change per second.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RATE          = 15          // target samples per second
const SAMPLE_INTERVAL      = 1 / SAMPLE_RATE
const ESTIMATE_INTERVAL    = 1.0         // re-estimate BPM every 1 second
const FACE_DETECT_INTERVAL = 0.9         // run face detection every 0.9 s
const BUFFER_SECONDS       = 12          // rolling buffer duration
const MIN_ANALYSIS_SECONDS = 6           // minimum buffer before estimating
const MIN_BPM              = 48
const MAX_BPM              = 180
const SMOOTH_ALPHA         = 0.85        // EMA weight for per-frame signal

// MediaPipe FaceLandmarker CDN (pinned version for stability)
const MP_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17'
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// Face landmark indices for forehead + cheek rPPG region
// (forehead center, brow region, cheeks bilaterally)
const FACE_ROI_LANDMARKS = [10, 9, 8, 107, 336, 116, 147, 187, 207, 345, 376, 411, 427]

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
        this._frameBuffer   = []          // {time, value}[]
        this._smoothedSignal = null       // running EMA of the raw signal

        this._canvas    = null
        this._canvasCtx = null
        this._faceBox      = null
        this._lastFaceSeen = 0
        this._lastValidBPM = null

        // MediaPipe FaceLandmarker (loaded lazily from CDN)
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

            // Small internal canvas for pixel access — keeps CPU cost low
            this._canvas    = document.createElement('canvas')
            this._canvas.width  = 96
            this._canvas.height = 72
            this._canvasCtx = this._canvas.getContext('2d', { willReadFrequently: true })

            this.available = true
            this._setIndicator('CAM ROI — LOADING FACE AI…')

            // Load MediaPipe FaceLandmarker in the background — rPPG starts
            // immediately with a fixed ROI and upgrades once the model is ready.
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

        // ── Stage B: periodic face detection ──
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

        // ── EMA smoothing of the raw chrominance signal ──
        if (this._smoothedSignal === null) {
            this._smoothedSignal = raw
        } else {
            this._smoothedSignal = SMOOTH_ALPHA * this._smoothedSignal + (1 - SMOOTH_ALPHA) * raw
        }

        const now = performance.now() / 1000
        this._frameBuffer.push({ time: now, value: this._smoothedSignal })

        // Trim old samples
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
            console.warn('[Biometrics] MediaPipe unavailable, using fixed ROI:', err.message)
            this._faceLandmarkerReady = false
        }
    }

    // ── PRIVATE — STAGE B: FACE DETECTION ─────────────────────────────────────

    _detectFace() {
        if (!this._faceLandmarkerReady || !this._faceLandmarker) return
        if (this.videoEl.readyState < 2) return
        try {
            const results = this._faceLandmarker.detectForVideo(this.videoEl, performance.now())
            const landmarks = results.faceLandmarks?.[0]
            if (landmarks) {
                const roi = this._computeROIFromLandmarks(landmarks)
                if (roi) {
                    this._faceBox = roi
                    this._lastFaceSeen = performance.now()
                }
            } else if (performance.now() - this._lastFaceSeen > 2000) {
                this._faceBox = null
            }
        } catch (err) {
            console.warn('[Biometrics] FaceLandmarker detect error:', err.message)
            this._faceLandmarkerReady = false
            this._faceBox = null
        }
    }

    _computeROIFromLandmarks(landmarks) {
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

        const imageData = this._canvasCtx.getImageData(x0, y0, x1 - x0, y1 - y0)
        const data      = imageData.data

        let rSum = 0, gSum = 0, bSum = 0, count = 0

        // Sample every 4th pixel (step=16 bytes = 4 RGBA pixels)
        // to keep CPU cost minimal while maintaining signal quality.
        for (let i = 0; i < data.length; i += 16) {
            const r = data[i], g = data[i + 1], b = data[i + 2]

            // ── Stage C: skin classification ──
            // Reject pixels that are too dark, too bright, or clearly not skin-toned.
            const lum = 0.299 * r + 0.587 * g + 0.114 * b
            if (lum < 30 || lum > 230) continue        // dark shadow / blown highlight
            if (r < 50 || r < b)        continue        // too little red — not skin
            if (g > r || b > r * 0.85)  continue        // greenish or blueish — not skin

            rSum += r; gSum += g; bSum += b
            count++
        }

        if (count < 15) return null   // fell back to no usable pixels

        const total = rSum + gSum + bSum
        if (total <= 0) return null

        // ── Stage D: Chrominance ratio (illumination-invariant) ──
        // (R - G) / sum  → positive when red dominates (oxygenated blood)
        // This outperforms a raw green-channel ratio in varying light conditions.
        return (rSum - gSum) / total
    }

    _getROI(width, height) {
        if (this._faceBox) return this._faceBox
        // Fixed centre ROI — covers typical forehead/cheek area in a face-to-screen pose
        return {
            x: width  * 0.28,
            y: height * 0.12,
            w: width  * 0.44,
            h: height * 0.55,
        }
    }

    // ── PRIVATE — STAGE F: BPM ESTIMATION VIA AUTOCORRELATION ────────────────

    _estimateBPM() {
        const samples = this._frameBuffer
        if (samples.length < SAMPLE_RATE * MIN_ANALYSIS_SECONDS) return null

        const duration = samples[samples.length - 1].time - samples[0].time
        if (duration < MIN_ANALYSIS_SECONDS) return null

        // 1. Resample to uniform grid at SAMPLE_RATE
        const uniform = this._resample(samples, SAMPLE_RATE)
        if (uniform.length < SAMPLE_RATE * MIN_ANALYSIS_SECONDS) return null

        // 2. Apply Hann window to reduce spectral leakage
        const windowed = this._applyHannWindow(uniform)

        // 3. Normalise (zero-mean, unit-variance)
        const mean  = windowed.reduce((a, v) => a + v, 0) / windowed.length
        const centred = windowed.map(v => v - mean)
        const std   = Math.sqrt(centred.reduce((a, v) => a + v * v, 0) / centred.length)
        if (std < 0.000005) return null  // flat signal — no pulse detected
        const normed = centred.map(v => v / std)

        // 4. Normalised autocorrelation over the valid BPM lag range
        const lagMin = Math.ceil( (60 / MAX_BPM) * SAMPLE_RATE )
        const lagMax = Math.floor( (60 / MIN_BPM) * SAMPLE_RATE )

        let bestLag = 0, bestScore = -Infinity
        for (let lag = lagMin; lag <= lagMax; lag++) {
            let score = 0, n = 0
            for (let i = lag; i < normed.length; i++) {
                score += normed[i] * normed[i - lag]
                n++
            }
            score = n ? score / n : -Infinity
            if (score > bestScore) { bestScore = score; bestLag = lag }
        }

        // Require a meaningful autocorrelation peak (≥0.15) to accept the estimate
        if (!bestLag || bestScore < 0.15) return null

        let bpm = Math.round((60 * SAMPLE_RATE) / bestLag)

        // 5. Temporal smoothing: blend with previous valid BPM, clamp step
        if (this._lastValidBPM !== null) {
            const maxStep = 10
            const delta   = Math.max(-maxStep, Math.min(maxStep, bpm - this._lastValidBPM))
            bpm           = Math.round(this._lastValidBPM + delta)
            bpm           = Math.round(this._lastValidBPM * 0.65 + bpm * 0.35)
        }

        bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, bpm))
        this._lastValidBPM = bpm

        return { bpm, confidence: Math.max(0, Math.min(1, bestScore)) }
    }

    // ── PRIVATE — HELPERS ──────────────────────────────────────────────────────

    /** Linearly interpolate samples onto a uniform time grid */
    _resample(samples, rate) {
        const result = []
        const step   = 1 / rate
        let si       = 0
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

    /** Hann window: w[i] = 0.5(1 - cos(2πi/(N-1))) */
    _applyHannWindow(values) {
        const N = values.length
        return values.map((v, i) => v * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))))
    }

    _statusText() {
        if (!this.available) return 'CAM OFF'
        if (!this.currentBPM) {
            if (this._faceLandmarkerReady && this._faceBox) return 'CAM FACE LOCK — CALIBRATING…'
            return 'CAM ROI — CALIBRATING…'
        }
        const src = this._faceLandmarkerReady && this._faceBox ? 'MP' : (this._faceBox ? 'FACE' : 'ROI')
        const pct = Math.round(this.confidence * 100)
        return `PULSE ${this.currentBPM} BPM [${src} ${pct}%]`
    }

    _setIndicator(text) {
        const el = document.getElementById('bpm-source')
        if (el) el.textContent = text
    }
}
