// src/biometrics.js — VitalLens rPPG (BPM + RR) + MediaPipe emotion blendshapes

const FACE_DETECT_INTERVAL = 0.40

const MP_CDN   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17'
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

const FOREHEAD_LM   = [10, 9, 8]
const LEFT_CHEEK_LM = [116, 147, 187, 207]
const RIGHT_CHEEK_LM = [345, 376, 411, 427]
const MOTION_LM     = [1, 4, 10, 152]
const MOTION_THRESHOLD = 0.008
const ROI_SMOOTH    = 0.35

const VL_API_KEY = '84oI7bhQAsc1a4gPF9gT3bgKnig0mnV1Di5EuSec'

export class Biometrics {
    constructor() {
        this.videoEl    = null
        this.stream     = null
        this.available  = false
        this.currentBPM = null
        this.confidence = 0

        this._detectTimer = 0
        this._canvas      = null
        this._canvasCtx   = null
        this._faceBox        = null
        this._rawFaceBox     = null
        this._roiForehead    = null
        this._roiLeftCheek   = null
        this._roiRightCheek  = null
        this._prevLandmarks  = null
        this._motionScore    = 0
        this._lastFaceSeen   = 0

        this._emotionFear      = 0
        this._emotionTension   = 0
        this._emotionAvailable = false
        this._lastBlendshapes  = null

        this._faceLandmarker      = null
        this._faceLandmarkerReady = false

        this._bpmStatus       = 'calibrating'
        this._respiratoryRate = null
        this._vl              = null
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
                this.videoEl.muted = true
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
            this.videoEl.muted = true
            try { await this.videoEl.play() } catch (playErr) {
                console.warn('[Biometrics] video.play() blocked:', playErr.message)
            }

            // Small canvas for MediaPipe face detection
            this._canvas       = document.createElement('canvas')
            this._canvas.width  = 96
            this._canvas.height = 72
            this._canvasCtx = this._canvas.getContext('2d', { willReadFrequently: true })

            this.available = true
            this._setIndicator('CAM — LOADING VITALLENS…')

            // Both pipelines start concurrently; VitalLens drives BPM, MediaPipe drives emotion
            this._initMediaPipe()
            this._initVitalLens()

            return true
        } catch (err) {
            console.warn('[Biometrics] Camera unavailable:', err.message)
            this.available = false
            this._setIndicator('CAM OFF')
            return false
        }
    }

    /** Called each game tick — only drives MediaPipe face detection now.
     *  VitalLens is event-driven and self-paced. */
    update(dt) {
        if (!this.available || !this.videoEl || !this._canvasCtx) return
        if (this.videoEl.readyState < 2) return

        this._detectTimer += dt
        if (this._detectTimer >= FACE_DETECT_INTERVAL) {
            this._detectTimer = 0
            this._detectFace()
        }
    }

    /** Called once per second by main.js — just refreshes the HUD indicator.
     *  BPM updates arrive via VitalLens 'vitals' events asynchronously. */
    triggerEstimate() {
        if (!this.available) return
        this._setIndicator(this._statusText())
    }

    getBPM()             { return this.currentBPM }
    isAvailable()        { return this.available  }
    getBPMStatus()       { return this._bpmStatus }
    getRespiratoryRate() { return this._respiratoryRate }
    getEmotionFear()     { return this._emotionAvailable ? this._emotionFear    : null }
    getEmotionTension()  { return this._emotionAvailable ? this._emotionTension : null }
    isEmotionAvailable() { return this._emotionAvailable }

    destroy() {
        try { this._vl?.stopVideoStream?.() } catch {}
        this._vl = null
        this.stream?.getTracks().forEach(t => t.stop())
        try { this._faceLandmarker?.close() } catch {}
        this._faceLandmarker      = null
        this._faceLandmarkerReady = false
        this.available  = false
        this.currentBPM = null
        this.confidence = 0
        this._setIndicator('CAM OFF')
    }

    // ── PRIVATE — VITALLENS INIT ───────────────────────────────────────────────

    async _initVitalLens() {
        let VitalLens
        try {
            ;({ VitalLens } = await import('vitallens'))
        } catch (err) {
            console.warn('[Biometrics] VitalLens module load failed:', err.message)
            this._bpmStatus = 'unavailable'
            this._setIndicator('VITALLENS UNAVAILABLE')
            return
        }

        // Try cloud API first, fall back to local rPPG
        const configs = [
            { method: 'vitallens', apiKey: VL_API_KEY },
            { method: 'pos' },
        ]
        for (const cfg of configs) {
            try {
                const vl = new VitalLens(cfg)
                vl.addVideoStream(this.stream, this.videoEl)
                vl.startVideoStream()
                this._vl = vl
                console.log(`[Biometrics] VitalLens started (${cfg.method})`)
                break
            } catch (err) {
                console.warn(`[Biometrics] VitalLens ${cfg.method} failed:`, err.message)
            }
        }

        if (!this._vl) {
            this._bpmStatus = 'unavailable'
            this._setIndicator('VITALLENS UNAVAILABLE')
            return
        }

        this._vl.addEventListener('vitals', (result) => {
            const hr = result.vital_signs?.heart_rate ?? result.vitals?.heart_rate
            const rr = result.vital_signs?.respiratory_rate ?? result.vitals?.respiratory_rate

            if (hr?.value != null) {
                this.currentBPM = Math.round(hr.value)
                this.confidence  = typeof hr.confidence === 'number' ? hr.confidence : 0
                this._bpmStatus  = this.confidence >= 0.35 ? 'stable' : 'calibrating'
            }
            if (rr?.value != null) {
                this._respiratoryRate = Math.round(rr.value)
            }
            this._setIndicator(this._statusText())
        })

        this._vl.addEventListener('streamReset', () => {
            console.warn('[Biometrics] VitalLens stream reset — waiting for reconnect')
            this.confidence = 0
            this._bpmStatus = 'calibrating'
            this._setIndicator('VITALLENS RECONNECTING…')
        })
    }

    // ── PRIVATE — MEDIAPIPE INIT ───────────────────────────────────────────────

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
                outputFaceBlendshapes: true,
                outputFacialTransformationMatrixes: false,
            })
            this._faceLandmarkerReady = true
            console.log('[Biometrics] MediaPipe FaceLandmarker ready (emotion only)')
        } catch (err) {
            console.warn('[Biometrics] MediaPipe unavailable:', err.message)
            this._faceLandmarkerReady = false
        }
    }

    // ── PRIVATE — FACE DETECTION (emotion blendshapes) ───────────────────────

    _detectFace() {
        if (!this._faceLandmarkerReady || !this._faceLandmarker) return
        if (this.videoEl.readyState < 2) return
        try {
            const results   = this._faceLandmarker.detectForVideo(this.videoEl, performance.now())
            const landmarks = results.faceLandmarks?.[0]
            if (landmarks) {
                this._updateMotionScore(landmarks)
                const raw = this._landmarksToBox(landmarks)
                if (raw) {
                    this._rawFaceBox  = raw
                    this._lastFaceSeen = performance.now()
                    this._faceBox     = this._smoothROI(this._faceBox, raw)
                }
                this._roiForehead   = this._smoothROI(this._roiForehead,   this._extractROI(landmarks, FOREHEAD_LM))
                this._roiLeftCheek  = this._smoothROI(this._roiLeftCheek,  this._extractROI(landmarks, LEFT_CHEEK_LM))
                this._roiRightCheek = this._smoothROI(this._roiRightCheek, this._extractROI(landmarks, RIGHT_CHEEK_LM))
                this._processBlendshapes(results.faceBlendshapes?.[0]?.categories)
            } else if (performance.now() - this._lastFaceSeen > 2500) {
                this._clearTrackedROIs()
                this._emotionAvailable = false
            }
        } catch (err) {
            console.warn('[Biometrics] FaceLandmarker detect error:', err.message)
            this._faceLandmarkerReady = false
            this._clearTrackedROIs()
            this._emotionAvailable = false
        }
    }

    /**
     * Convert MediaPipe blendshapes → fear/tension scores.
     * Fear = wide eyes + raised inner brows + parted/stretched mouth (FACS AU1+AU5+AU20+AU26).
     * Tension = jaw clench + lip press + brow furrow.
     */
    _processBlendshapes(categories) {
        if (!categories || !categories.length) {
            this._emotionAvailable = false
            return
        }
        this._lastBlendshapes = categories
        const get = (name) => {
            const c = categories.find(c => c.categoryName === name)
            return c ? c.score : 0
        }
        const browInnerUp  = get('browInnerUp')
        const eyeWide      = (get('eyeWideLeft')      + get('eyeWideRight'))      * 0.5
        const mouthStretch = (get('mouthStretchLeft') + get('mouthStretchRight')) * 0.5
        const jawOpen      = get('jawOpen')
        const mouthFrown   = (get('mouthFrownLeft')   + get('mouthFrownRight'))   * 0.5
        const browDown     = (get('browDownLeft')     + get('browDownRight'))     * 0.5
        const mouthPress   = (get('mouthPressLeft')   + get('mouthPressRight'))   * 0.5

        const rawFear =
            0.40 * browInnerUp +
            0.30 * eyeWide +
            0.15 * mouthStretch +
            0.10 * jawOpen +
            0.05 * mouthFrown
        const rawTension =
            0.45 * mouthPress +
            0.35 * browDown +
            0.20 * (1 - jawOpen)

        const SMOOTH = 0.7
        this._emotionFear    = this._emotionFear    * SMOOTH + Math.max(0, Math.min(1, rawFear * 1.4))  * (1 - SMOOTH)
        this._emotionTension = this._emotionTension * SMOOTH + Math.max(0, Math.min(1, rawTension))      * (1 - SMOOTH)
        this._emotionAvailable = true
    }

    _clearTrackedROIs() {
        this._faceBox       = null
        this._rawFaceBox    = null
        this._roiForehead   = null
        this._roiLeftCheek  = null
        this._roiRightCheek = null
        this._prevLandmarks = null
        this._motionScore   = 0
    }

    _updateMotionScore(landmarks) {
        if (this._prevLandmarks) {
            let sumDist = 0, count = 0
            for (const idx of MOTION_LM) {
                const a = this._prevLandmarks[idx]
                const b = landmarks[idx]
                if (!a || !b) continue
                const dx = a.x - b.x
                const dy = a.y - b.y
                sumDist += Math.sqrt(dx * dx + dy * dy)
                count++
            }
            this._motionScore = count ? sumDist / count : 0
        }
        this._prevLandmarks = landmarks.map(lm => ({ x: lm.x, y: lm.y, z: lm.z ?? 0 }))
    }

    _smoothROI(prev, raw) {
        if (!raw)  return prev
        if (!prev) return { ...raw }
        return {
            x: prev.x * ROI_SMOOTH + raw.x * (1 - ROI_SMOOTH),
            y: prev.y * ROI_SMOOTH + raw.y * (1 - ROI_SMOOTH),
            w: prev.w * ROI_SMOOTH + raw.w * (1 - ROI_SMOOTH),
            h: prev.h * ROI_SMOOTH + raw.h * (1 - ROI_SMOOTH),
        }
    }

    _extractROI(landmarks, indices) {
        const w = this._canvas.width
        const h = this._canvas.height
        let minX = 1, minY = 1, maxX = 0, maxY = 0
        let found = false
        for (const idx of indices) {
            const lm = landmarks[idx]
            if (!lm) continue
            minX = Math.min(minX, lm.x)
            maxX = Math.max(maxX, lm.x)
            minY = Math.min(minY, lm.y)
            maxY = Math.max(maxY, lm.y)
            found = true
        }
        if (!found) return null
        const pad = 0.025
        return {
            x: Math.max(0, (minX - pad) * w),
            y: Math.max(0, (minY - pad) * h),
            w: Math.max(6, Math.min(w, (maxX - minX + pad * 2) * w)),
            h: Math.max(6, Math.min(h, (maxY - minY + pad * 2) * h)),
        }
    }

    _landmarksToBox(landmarks) {
        const FACE_ROI_LM = [10, 9, 8, 107, 336, 116, 147, 187, 207, 345, 376, 411, 427]
        const w = this._canvas.width
        const h = this._canvas.height
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const idx of FACE_ROI_LM) {
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

    // ── PRIVATE — HUD ─────────────────────────────────────────────────────────

    _statusText() {
        if (!this.available) return 'CAM OFF'
        if (this._bpmStatus === 'unavailable') return 'VITALLENS UNAVAILABLE'
        const emoStr = this._emotionAvailable
            ? ` · FACE ${Math.round(this._emotionFear * 100)}%`
            : ''
        const rrStr  = this._respiratoryRate != null
            ? ` · RR ${this._respiratoryRate}`
            : ''
        if (!this.currentBPM) return `VL CALIBRATING…${emoStr}`
        const tag = this._bpmStatus === 'stable' ? 'OK' : 'CAL'
        return `PULSE ${this.currentBPM} BPM [VL ${Math.round(this.confidence * 100)}%][${tag}]${rrStr}${emoStr}`
    }

    _setIndicator(text) {
        const el = document.getElementById('bpm-source')
        if (el) el.textContent = text
    }
}
