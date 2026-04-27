// src/lobby.js — Lobby UI (host/join, copy code, multi-player, role assignment)
export class Lobby {
    constructor(socket) {
        this.socket = socket
        this.onGameStart = null
        this.isHost = false
        this.joinPending = false

        this._setupSocketEvents()
        this._setupUI()
    }

    _setupUI() {
        document.getElementById('btn-host').addEventListener('click', () => {
            this.socket.emit('createLobby')
            document.getElementById('status-msg').textContent = 'Creating lobby…'
        })


        document.getElementById('btn-join').addEventListener('click', () => {
            if (this.joinPending) return
            const code = document.getElementById('code-input').value.trim().toUpperCase()
            if (code.length < 2) {
                document.getElementById('status-msg').textContent = '⚠ Enter a room code first'
                return
            }
            this.joinPending = true
            document.getElementById('btn-join').disabled = true
            this.socket.emit('joinLobby', code)
            document.getElementById('status-msg').textContent = `Joining ${code}…`
        })

        document.getElementById('code-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('btn-join').click()
        })

        // Copy code button
        const copyBtn = document.getElementById('btn-copy-code')
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const code = document.getElementById('room-code').textContent
                if (!code || code === '----') return
                navigator.clipboard.writeText(code).then(() => {
                    copyBtn.textContent = '✅ COPIED!'
                    setTimeout(() => { copyBtn.textContent = '📋 COPY' }, 1500)
                }).catch(() => {
                    const ta = document.createElement('textarea')
                    ta.value = code
                    document.body.appendChild(ta)
                    ta.select()
                    document.execCommand('copy')
                    document.body.removeChild(ta)
                    copyBtn.textContent = '✅ COPIED!'
                    setTimeout(() => { copyBtn.textContent = '📋 COPY' }, 1500)
                })
            })
        }

        // Paste code button — reads clipboard into the code input
        const pasteBtn = document.getElementById('btn-paste-code')
        if (pasteBtn) {
            pasteBtn.addEventListener('click', async () => {
                try {
                    const text = await navigator.clipboard.readText()
                    const code = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
                    if (code) {
                        document.getElementById('code-input').value = code
                        pasteBtn.textContent = '✅ PASTED!'
                        setTimeout(() => { pasteBtn.textContent = '📋 PASTE' }, 1200)
                    }
                } catch {
                    // Browser blocked clipboard read — prompt user to paste manually
                    const input = document.getElementById('code-input')
                    input.focus()
                    input.select()
                    pasteBtn.textContent = 'CTRL+V'
                    setTimeout(() => { pasteBtn.textContent = '📋 PASTE' }, 1500)
                }
            })
        }

        // Start game button (host only)
        const startBtn = document.getElementById('btn-start-game')
        if (startBtn) {
            startBtn.addEventListener('click', () => {
                this.socket.emit('startGame')
                startBtn.textContent = 'STARTING…'
                startBtn.disabled = true
            })
        }

        this._setupTestPanel()
    }

    _setupTestPanel() {
        this._testCamStream = null
        this._testMicStream = null
        this._testMicCtx    = null
        this._testMicActive = false
        this._vlLobby       = null

        document.getElementById('btn-test-cam')?.addEventListener('click', () => this._testCamera())
        document.getElementById('btn-test-mic')?.addEventListener('click', () => this._testMic())
    }

    async _testCamera() {
        const btn    = document.getElementById('btn-test-cam')
        const status = document.getElementById('test-cam-status')
        const video  = document.getElementById('test-cam-video')

        if (this._testCamStream) {
            this._testCamStream.getTracks().forEach(t => t.stop())
            this._testCamStream = null
            if (video)  { video.srcObject = null; video.style.display = 'none' }
            if (status) { status.textContent = 'NOT TESTED'; status.style.color = '' }
            if (btn)    { btn.textContent = '📷 CAMERA'; btn.classList.remove('active') }
            this._stopBPMSampler()
            return
        }

        if (status) status.textContent = 'REQUESTING…'
        if (btn)    btn.textContent = '⏳ WAIT…'

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
                audio: false,
            })
            this._testCamStream = stream
            if (video) { video.srcObject = stream; video.style.display = 'block' }
            if (status) { status.textContent = '✓ CAMERA OK — measuring BPM…'; status.style.color = '#00ffcc' }
            if (btn)    { btn.textContent = '📷 STOP'; btn.classList.add('active') }
            this._startBPMSampler(video)
        } catch (e) {
            if (status) { status.textContent = '✗ BLOCKED'; status.style.color = '#ff003c' }
            if (btn)    { btn.textContent = '📷 CAMERA'; btn.classList.remove('active') }
        }
    }

    async _startBPMSampler(videoEl) {
        this._stopBPMSampler()

        const disp = document.getElementById('test-bpm-display')
        if (disp) { disp.classList.remove('hidden'); disp.textContent = '♥ CALIBRATING…'; disp.style.color = '#555' }

        let VitalLens
        try {
            ;({ VitalLens } = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/vitallens@0.4.5/dist/vitallens.browser.js'))
        } catch (err) {
            console.warn('[Lobby] VitalLens module unavailable:', err.message)
            if (disp) { disp.textContent = '♥ UNAVAILABLE'; disp.style.color = '#ff003c' }
            return
        }

        const configs = [
            { method: 'vitallens', apiKey: '84oI7bhQAsc1a4gPF9gT3bgKnig0mnV1Di5EuSec' },
            { method: 'pos' },
        ]
        for (const cfg of configs) {
            try {
                const vl = new VitalLens(cfg)
                vl.addVideoStream(this._testCamStream, videoEl)
                vl.startVideoStream()
                this._vlLobby = vl
                console.log(`[Lobby] VitalLens started (${cfg.method})`)
                break
            } catch (err) {
                console.warn(`[Lobby] VitalLens ${cfg.method} failed:`, err.message)
            }
        }

        if (!this._vlLobby) {
            if (disp) { disp.textContent = '♥ UNAVAILABLE'; disp.style.color = '#ff003c' }
            return
        }

        this._vlLobby.addEventListener('vitals', (result) => {
            const hr = result.vital_signs?.heart_rate ?? result.vitals?.heart_rate
            if (!hr?.value || !disp) return
            const bpm = Math.round(hr.value)
            disp.textContent = `♥ ${bpm} BPM`
            disp.style.color = bpm >= 100 ? '#ff003c' : '#00ffcc'
            disp.style.textShadow = bpm >= 100
                ? '0 0 10px rgba(255,0,60,0.7)'
                : '0 0 10px rgba(0,255,204,0.5)'
        })
    }

    _stopBPMSampler() {
        try { this._vlLobby?.stopVideoStream?.() } catch {}
        this._vlLobby = null
        const disp = document.getElementById('test-bpm-display')
        if (disp) { disp.classList.add('hidden'); disp.textContent = 'BPM: --' }
    }

    async _testMic() {
        const btn   = document.getElementById('btn-test-mic')
        const wrap  = document.getElementById('test-mic-bar-wrap')
        const fill  = document.getElementById('test-mic-fill')
        const micSt = document.getElementById('test-mic-status')

        if (this._testMicActive) {
            this._testMicActive = false
            this._testMicStream?.getTracks().forEach(t => t.stop())
            this._testMicStream = null
            try { this._testMicCtx?.close() } catch {}
            this._testMicCtx = null
            if (wrap) wrap.classList.add('hidden')
            if (btn)  { btn.textContent = '🎙 MIC'; btn.classList.remove('active') }
            return
        }

        if (btn) btn.textContent = '⏳ WAIT…'

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            this._testMicStream = stream
            const ctx      = new (window.AudioContext || window.webkitAudioContext)()
            this._testMicCtx = ctx
            const source   = ctx.createMediaStreamSource(stream)
            const analyser = ctx.createAnalyser()
            analyser.fftSize = 256
            source.connect(analyser)
            const buf = new Uint8Array(analyser.frequencyBinCount)

            if (wrap)  wrap.classList.remove('hidden')
            if (micSt) { micSt.textContent = 'MIC ACTIVE'; micSt.style.color = '#00ffcc' }
            if (btn)   { btn.textContent = '🎙 STOP'; btn.classList.add('active') }

            this._testMicActive = true
            const tick = () => {
                if (!this._testMicActive) { if (fill) fill.style.width = '0%'; return }
                analyser.getByteFrequencyData(buf)
                const avg = buf.reduce((a, b) => a + b, 0) / buf.length
                if (fill) fill.style.width = `${Math.min(100, avg * 2.8)}%`
                requestAnimationFrame(tick)
            }
            tick()
        } catch (e) {
            if (micSt) { micSt.textContent = 'MIC BLOCKED'; micSt.style.color = '#ff003c' }
            if (wrap)  wrap.classList.remove('hidden')
            if (btn)   { btn.textContent = '🎙 MIC'; btn.classList.remove('active') }
        }
    }

    _stopTestStreams() {
        this._stopBPMSampler()
        if (this._testCamStream) {
            this._testCamStream.getTracks().forEach(t => t.stop())
            this._testCamStream = null
        }
        this._testMicActive = false
        if (this._testMicStream) {
            this._testMicStream.getTracks().forEach(t => t.stop())
            this._testMicStream = null
        }
        try { this._testMicCtx?.close() } catch {}
        this._testMicCtx = null
    }

    _setupSocketEvents() {
        this.socket.on('lobbyCreated', (code) => {
            this.isHost = true
            document.getElementById('room-code').textContent = code
            document.getElementById('room-code-panel').style.display = 'block'
            document.getElementById('status-msg').textContent = '👻 Waiting for players to join…'
            const startBtn = document.getElementById('btn-start-game')
            if (startBtn) startBtn.classList.remove('hidden')
            this._pulseCode()
        })

        this.socket.on('lobbyJoined', (code) => {
            this.joinPending = false
            document.getElementById('btn-join').disabled = false
            document.getElementById('room-code').textContent = code
            document.getElementById('room-code-panel').style.display = 'block'
            document.getElementById('status-msg').textContent = '⏳ Waiting for host to start…'
        })

        this.socket.on('youAreHost', () => {
            this.isHost = true
            const startBtn = document.getElementById('btn-start-game')
            if (startBtn) startBtn.classList.remove('hidden')
            document.getElementById('status-msg').textContent = '👑 You are now the host'
        })

        this.socket.on('playerCount', ({ count, max }) => {
            const el = document.getElementById('player-count')
            if (el) el.textContent = `Players: ${count}/${max}`
            // Enable start when ≥2 players
            const startBtn = document.getElementById('btn-start-game')
            if (startBtn && this.isHost) {
                startBtn.disabled = count < 2
            }
        })

        this.socket.on('lobbyError', (msg) => {
            this.joinPending = false
            document.getElementById('btn-join').disabled = false
            document.getElementById('status-msg').textContent = `⚠ ${msg}`
        })

        // Primary role event — server sends our role directly
        this.socket.on('yourRole', ({ role, peers }) => {
            console.log(`[LOBBY] Assigned Role: ${role}, Peers:`, peers)
            this._startGame(role, peers)
        })

        // gameStart is still emitted for UI (pulse stop, etc.)
        this.socket.on('gameStart', () => {
            // noop — role handled by 'yourRole'
        })

        this.socket.on('peerDisconnected', ({ id }) => {
            console.log(`[LOBBY] Peer disconnected: ${id}`)
        })
    }

    _startGame(role, peers) {
        this._stopTestStreams()
        // Hide lobby
        document.getElementById('ui-overlay').classList.add('hidden')
        // Show HUD
        document.getElementById('hud').classList.remove('hidden')
        if (this.onGameStart) this.onGameStart(role, peers)
    }

    _pulseCode() {
        const el = document.getElementById('room-code')
        let bright = true
        const iv = setInterval(() => {
            el.style.opacity = bright ? '1' : '0.4'
            bright = !bright
        }, 500)
        this.socket.once('gameStart', () => clearInterval(iv))
    }
}
