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
