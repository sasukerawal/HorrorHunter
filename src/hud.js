// src/hud.js — HUD (timer, fear pulse-wave, crosshair, BPM debug)
// Inspired by 3d-force-graph data-binding pattern: canvas redraws on each data update

export class HUD {
    constructor() {
        this.timerEl = document.getElementById('hud-timer')
        this.bpmEl = document.getElementById('hud-bpm')
        this.roleEl = document.getElementById('hud-role')
        this.fearCanvas = document.getElementById('fear-graph')
        this.fearCtx = this.fearCanvas ? this.fearCanvas.getContext('2d') : null
        this.crosshair = document.getElementById('crosshair')
        this.debugSlider = document.getElementById('bpm-slider')
        this.debugBpmDisplay = document.getElementById('bpm-display')

        // New panels (added in index.html)
        this.vignetteEl     = document.getElementById('vignette')
        this.staminaFillEl  = document.getElementById('stamina-fill')
        this.staminaWrapEl  = document.getElementById('stamina-wrap')
        this.phaseFillEl    = document.getElementById('phase-fill')
        this.phaseWrapEl    = document.getElementById('phase-wrap')
        this.phaseLabelEl   = document.getElementById('phase-label')
        this.extractArrowEl = document.getElementById('extraction-arrow')
        this.flashlightEl   = document.getElementById('flashlight-status')
        this.hideHintEl     = document.getElementById('hide-hint')
        this.hpEl           = document.getElementById('hud-hp')

        this.totalTime = 180 // 3 minutes
        this.timeLeft = this.totalTime
        this.role = 'prey'
        this.fearHistory = new Array(200).fill(0)
        this.running = false

        // Net gun bloom (sized by Prey fear, set by main.js)
        this.crosshairBloom = 0

        this._setupDebugSlider()
    }

    _setupDebugSlider() {
        const params = new URLSearchParams(window.location.search)
        if (params.get('debug') === '1') {
            const container = document.getElementById('debug-panel')
            if (container) container.style.display = 'block'
        }
    }

    start(role) {
        this.role = role
        this.running = true
        this.roleEl.textContent = role === 'hunter' ? '🔦 HUNTER' : '👻 PREY'
        this.roleEl.style.color = role === 'hunter' ? '#ff3333' : '#33ccff'

        if (this.crosshair) {
            this.crosshair.style.display = role === 'hunter' ? 'flex' : 'none'
        }
        // Phase + stamina bars are Prey-only
        if (this.staminaWrapEl) this.staminaWrapEl.classList.toggle('hidden', role !== 'prey')
        if (this.phaseWrapEl)   this.phaseWrapEl.classList.toggle('hidden',   role !== 'prey')
        // HP display is Prey-only
        if (this.hpEl) this.hpEl.classList.toggle('hidden', role !== 'prey')
        if (role === 'prey') this.setHP(3, 3)
    }

    setHP(hp, maxHp = 3) {
        if (!this.hpEl) return
        let hearts = ''
        for (let i = 0; i < maxHp; i++) {
            hearts += i < hp ? '❤️' : '🖤'
        }
        this.hpEl.textContent = hearts
        if (hp <= 1 && hp > 0) {
            this.hpEl.classList.add('hp-critical')
        } else {
            this.hpEl.classList.remove('hp-critical')
        }
    }

    /** Bloom drives crosshair size + a CSS scale. Higher fear → larger circle. */
    setCrosshairBloom(bloom) {
        this.crosshairBloom = bloom
        if (!this.crosshair || this.role !== 'hunter') return
        const scale = 1 + Math.min(4, bloom * 18)
        this.crosshair.style.transform = `translate(-50%, -50%) scale(${scale})`
        this.crosshair.style.opacity   = String(Math.max(0.5, 1 - bloom * 1.5))
    }

    /** Vignette darkens the screen borders as Prey fear rises */
    setVignetteFear(fear) {
        if (!this.vignetteEl) return
        const op = 0.55 + Math.min(0.4, fear * 0.55)
        this.vignetteEl.style.setProperty('--vignette-opacity', op.toFixed(2))
        this.vignetteEl.classList.toggle('high', fear > 0.7)
    }

    setFlashlightStatus(on) {
        if (!this.flashlightEl) return
        this.flashlightEl.textContent = on ? '🔦 FLASHLIGHT ON' : '🔦 FLASHLIGHT OFF'
        this.flashlightEl.classList.toggle('off', !on)
    }

    setStamina(stamina, max = 100) {
        if (!this.staminaFillEl) return
        const pct = Math.max(0, Math.min(1, stamina / max))
        this.staminaFillEl.style.width = `${pct * 100}%`
    }

    setPhaseState(cooldown, isPhasing, hasFear) {
        if (!this.phaseFillEl) return
        if (isPhasing) {
            this.phaseFillEl.style.width = '100%'
            this.phaseLabelEl.textContent = 'PHASING'
            this.phaseWrapEl.classList.add('active')
            this.phaseWrapEl.classList.remove('locked')
        } else if (cooldown > 0) {
            const pct = 1 - (cooldown / 10)
            this.phaseFillEl.style.width = `${pct * 100}%`
            this.phaseLabelEl.textContent = `PHASE ${cooldown.toFixed(1)}s`
            this.phaseWrapEl.classList.remove('active')
            this.phaseWrapEl.classList.add('locked')
        } else if (!hasFear) {
            this.phaseFillEl.style.width = '100%'
            this.phaseLabelEl.textContent = 'PHASE — NEED FEAR > 50%'
            this.phaseWrapEl.classList.remove('active')
            this.phaseWrapEl.classList.add('locked')
        } else {
            this.phaseFillEl.style.width = '100%'
            this.phaseLabelEl.textContent = 'PHASE READY [Q]'
            this.phaseWrapEl.classList.remove('active', 'locked')
        }
    }

    /** Show + rotate the extraction arrow toward dirVec (xz Vector3). yaw is camera yaw (radians). */
    setExtractionArrow(visible, dirVec = null, cameraYaw = 0) {
        if (!this.extractArrowEl) return
        if (!visible || !dirVec) {
            this.extractArrowEl.classList.add('hidden')
            return
        }
        this.extractArrowEl.classList.remove('hidden')
        // World-space angle to extraction (atan2(x, z) gives angle from +Z)
        const worldAngle = Math.atan2(dirVec.x, dirVec.z)
        // Subtract camera yaw to get relative direction (camera looks down -Z when yaw=0)
        let rel = worldAngle - cameraYaw + Math.PI
        // Wrap to [-PI, PI]
        while (rel >  Math.PI) rel -= Math.PI * 2
        while (rel < -Math.PI) rel += Math.PI * 2
        this.extractArrowEl.style.transform = `translate(-50%, -50%) rotate(${rel}rad)`
    }

    setHideHint(visible, isHiding) {
        if (!this.hideHintEl) return
        if (!visible && !isHiding) { this.hideHintEl.classList.remove('visible'); return }
        this.hideHintEl.classList.add('visible')
        this.hideHintEl.textContent = isHiding ? '[E] EXIT LOCKER' : '[E] HIDE IN LOCKER'
    }

    getManualBPM() {
        if (this.debugSlider) return parseInt(this.debugSlider.value)
        return null
    }

    update(dt, fearLevel, bpm) {
        if (!this.running) return

        // Timer countdown
        this.timeLeft -= dt
        if (this.timeLeft < 0) this.timeLeft = 0
        const minutes = Math.floor(this.timeLeft / 60)
        const seconds = Math.floor(this.timeLeft % 60)
        if (this.timerEl) {
            this.timerEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`
            if (this.timeLeft < 30) this.timerEl.style.color = '#ff0000'
        }

        // BPM display
        if (this.bpmEl) this.bpmEl.textContent = `♥ ${bpm} BPM`
        if (this.debugBpmDisplay && this.debugSlider) {
            this.debugBpmDisplay.textContent = this.debugSlider.value
        }

        // Fear pulse wave (3d-force-graph data-binding pattern applied to canvas)
        this.fearHistory.shift()
        this.fearHistory.push(fearLevel)
        this._drawFearGraph(fearLevel)
    }

    _drawFearGraph(fearLevel) {
        if (!this.fearCtx) return
        const w = this.fearCanvas.width
        const h = this.fearCanvas.height
        const ctx = this.fearCtx

        ctx.clearRect(0, 0, w, h)

        // Background
        ctx.fillStyle = 'rgba(0,0,0,0.7)'
        ctx.fillRect(0, 0, w, h)

        // Border glow
        const r = Math.floor(fearLevel * 255)
        const g = Math.floor((1 - fearLevel) * 80)
        ctx.strokeStyle = `rgb(${r},${g},0)`
        ctx.lineWidth = 1
        ctx.strokeRect(0, 0, w, h)

        // Pulse wave line
        ctx.beginPath()
        ctx.lineWidth = 1.5
        const gradient = ctx.createLinearGradient(0, 0, w, 0)
        gradient.addColorStop(0, `rgba(${r},${g},50,0)`)
        gradient.addColorStop(0.5, `rgb(${r},${g},50)`)
        gradient.addColorStop(1, `rgba(${r},${g},50,0.3)`)
        ctx.strokeStyle = gradient
        ctx.shadowBlur = fearLevel * 12
        ctx.shadowColor = `rgb(${r},${g},0)`

        const step = w / this.fearHistory.length
        this.fearHistory.forEach((v, i) => {
            const x = i * step
            // Heartbeat-style: base wave + spike at peak
            const base = h / 2
            const amp = v * (h / 2 - 4)
            const wave = amp * Math.sin((i / this.fearHistory.length) * Math.PI * 2 * 4 + Date.now() * 0.003)
            const y = base - wave - (v > 0.7 ? Math.random() * v * 6 : 0)
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
        })
        ctx.stroke()

        // Fear % text
        ctx.shadowBlur = 0
        ctx.fillStyle = `rgb(${r},${g},80)`
        ctx.font = 'bold 10px monospace'
        ctx.fillText(`FEAR ${Math.round(fearLevel * 100)}%`, 6, h - 5)
    }

    showGameOver(winner) {
        const overlay = document.getElementById('gameover-overlay')
        const msg = document.getElementById('gameover-msg')
        if (overlay) overlay.classList.remove('hidden')
        if (msg) {
            msg.textContent = winner === 'hunter' ? '🔦 HUNTER WINS — PREY CAUGHT' : '👻 PREY ESCAPED — PREY WINS'
            msg.style.color = winner === 'hunter' ? '#ff3333' : '#33ccff'
        }
    }
}
