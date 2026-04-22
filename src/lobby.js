// src/lobby.js — Lobby UI (4-char code host/join, role assignment)
export class Lobby {
    constructor(socket) {
        this.socket = socket
        this.onGameStart = null

        this._setupSocketEvents()
        this._setupUI()
    }

    _setupUI() {
        document.getElementById('btn-host').addEventListener('click', () => {
            this.socket.emit('createLobby')
            document.getElementById('status-msg').textContent = 'Creating lobby…'
        })

        document.getElementById('btn-join').addEventListener('click', () => {
            const code = document.getElementById('code-input').value.trim().toUpperCase()
            if (code.length < 2) {
                document.getElementById('status-msg').textContent = '⚠ Enter a room code first'
                return
            }
            this.socket.emit('joinLobby', code)
            document.getElementById('status-msg').textContent = `Joining ${code}…`
        })

        document.getElementById('code-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('btn-join').click()
        })
    }

    _setupSocketEvents() {
        this.socket.on('lobbyCreated', (code) => {
            document.getElementById('room-code').textContent = code
            document.getElementById('room-code-panel').style.display = 'block'
            document.getElementById('status-msg').textContent = '👻 Waiting for Prey to join…'
            this._pulseCode()
        })

        this.socket.on('lobbyError', (msg) => {
            document.getElementById('status-msg').textContent = `⚠ ${msg}`
        })

        // Primary role event — server sends our role directly, no ID comparison needed
        this.socket.on('yourRole', ({ role, peerId }) => {
            console.log(`[LOBBY] Assigned Role: ${role}, Peer: ${peerId}`)
            this._startGame(role, peerId)
        })

        // gameStart is still emitted for UI fallback (pulse stop, etc.)
        this.socket.on('gameStart', ({ hunter, prey }) => {
            // noop — role handled by 'yourRole'
        })

        this.socket.on('peerDisconnected', () => {
            document.getElementById('gameover-overlay').classList.remove('hidden')
            document.getElementById('gameover-msg').textContent = '⚠ Other player disconnected'
        })
    }

    _startGame(role, peerId) {
        // Hide lobby
        document.getElementById('ui-overlay').classList.add('hidden')
        // Show HUD
        document.getElementById('hud').classList.remove('hidden')
        if (this.onGameStart) this.onGameStart(role, peerId)
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
