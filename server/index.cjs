// server/index.cjs — Bio-Horror Socket.IO Server (CommonJS for Node.js)
// Multi-player: 1 hunter + N prey, HP system, health pickups
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
})

const lobbies = {}

function genCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase()
}

io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`)

    // --- Lobby Management ---
    socket.on('createLobby', () => {
        if (socket.lobbyCode && lobbies[socket.lobbyCode]) {
            socket.emit('lobbyCreated', socket.lobbyCode)
            const lobby = lobbies[socket.lobbyCode]
            io.to(socket.lobbyCode).emit('playerCount', { count: lobby.players.length, max: lobby.maxPlayers })
            return
        }

        const code = genCode()
        lobbies[code] = {
            players: [{ id: socket.id, role: null, hp: 3 }],
            host: socket.id,
            state: 'waiting',
            maxPlayers: 8,
        }
        socket.join(code)
        socket.lobbyCode = code
        socket.emit('lobbyCreated', code)
        io.to(code).emit('playerCount', { count: 1, max: 8 })
        console.log(`[LOBBY] Created ${code} by ${socket.id}`)
    })

    socket.on('joinLobby', (code) => {
        code = String(code || '').trim().toUpperCase()
        if (socket.lobbyCode && lobbies[socket.lobbyCode]) {
            const currentLobby = lobbies[socket.lobbyCode]
            if (socket.lobbyCode === code) {
                socket.emit('lobbyJoined', code)
                io.to(code).emit('playerCount', { count: currentLobby.players.length, max: currentLobby.maxPlayers })
            } else {
                socket.emit('lobbyError', 'Already in a room')
            }
            return
        }

        const lobby = lobbies[code]
        if (!lobby) {
            socket.emit('lobbyError', 'Room not found')
            return
        }
        if (lobby.state !== 'waiting') {
            socket.emit('lobbyError', 'Game already in progress')
            return
        }
        if (lobby.players.length >= lobby.maxPlayers) {
            socket.emit('lobbyError', 'Room is full')
            return
        }
        if (lobby.players.some(p => p.id === socket.id)) {
            socket.emit('lobbyJoined', code)
            io.to(code).emit('playerCount', { count: lobby.players.length, max: lobby.maxPlayers })
            return
        }

        lobby.players.push({ id: socket.id, role: null, hp: 3 })
        socket.join(code)
        socket.lobbyCode = code

        socket.emit('lobbyJoined', code)
        io.to(code).emit('playerCount', { count: lobby.players.length, max: lobby.maxPlayers })
        console.log(`[LOBBY] ${socket.id} joined ${code} (${lobby.players.length} players)`)
    })

    // Host starts game when ready
    socket.on('startGame', () => {
        const code = socket.lobbyCode
        const lobby = lobbies[code]
        if (!lobby || lobby.host !== socket.id) return
        if (lobby.players.length < 2) {
            socket.emit('lobbyError', 'Need at least 2 players')
            return
        }

        lobby.state = 'ingame'

        // Randomize who is hunter — pick 1 random player
        const hunterIdx = Math.floor(Math.random() * lobby.players.length)

        lobby.players.forEach((p, i) => {
            p.role = i === hunterIdx ? 'hunter' : 'prey'
            p.hp = p.role === 'prey' ? 3 : Infinity
        })

        const hunterPlayer = lobby.players[hunterIdx]
        const preyPlayers = lobby.players.filter(p => p.role === 'prey')

        console.log(`[GAME] Role Assignment for ${code}:`)
        console.log(`   - Hunter: ${hunterPlayer.id}`)
        preyPlayers.forEach(p => console.log(`   - Prey: ${p.id}`))

        // Send role to each player with full peer list
        lobby.players.forEach(p => {
            const peers = lobby.players
                .filter(other => other.id !== p.id)
                .map(other => ({ id: other.id, role: other.role }))
            io.to(p.id).emit('yourRole', { role: p.role, peers })
        })

        io.to(code).emit('gameStart', {
            hunter: hunterPlayer.id,
            prey: preyPlayers.map(p => p.id)
        })
        console.log(`[LOBBY] ${code} started with ${lobby.players.length} players.`)
    })

    // --- Gameplay Events ---
    socket.on('playerMove', (data) => {
        // Broadcast position/rotation to all other players in the room
        socket.to(socket.lobbyCode).emit('peerMove', { id: socket.id, ...data })
    })

    socket.on('fearUpdate', (data) => {
        // Broadcast prey fear level to all other players
        socket.to(socket.lobbyCode).emit('peerFear', { id: socket.id, fear: data.fear, bpm: data.bpm })
    })

    socket.on('doorToggle', (data) => {
        // Relay door state to every other client so the map stays in sync
        socket.to(socket.lobbyCode).emit('doorToggle', data)
    })

    socket.on('voiceOffer', ({ targetId, description }) => {
        if (!targetId || !description) return
        io.to(targetId).emit('voiceOffer', { fromId: socket.id, description })
    })

    socket.on('voiceAnswer', ({ targetId, description }) => {
        if (!targetId || !description) return
        io.to(targetId).emit('voiceAnswer', { fromId: socket.id, description })
    })

    socket.on('voiceIceCandidate', ({ targetId, candidate }) => {
        if (!targetId || !candidate) return
        io.to(targetId).emit('voiceIceCandidate', { fromId: socket.id, candidate })
    })

    socket.on('voicePanic', ({ level, type = 'panic' }) => {
        const code = socket.lobbyCode
        const lobby = lobbies[code]
        if (!lobby) return
        const sender = lobby.players.find(p => p.id === socket.id)
        if (!sender || sender.role !== 'prey') return
        for (const player of lobby.players) {
            if (player.role === 'hunter') io.to(player.id).emit('voicePanic', { fromId: socket.id, level, type })
        }
    })

    socket.on('netFired', (data) => {
        // Hunter fires net gun — broadcast to all prey
        socket.to(socket.lobbyCode).emit('netHit', { ...data, shooterId: socket.id })
    })

    // HP-based catch system
    socket.on('netHitConfirm', ({ targetId }) => {
        const code = socket.lobbyCode
        const lobby = lobbies[code]
        if (!lobby) return

        const target = lobby.players.find(p => p.id === targetId)
        if (!target || target.role !== 'prey') return

        target.hp = Math.max(0, target.hp - 1)
        io.to(code).emit('preyHP', { id: targetId, hp: target.hp })
        console.log(`[GAME] ${targetId} hit! HP: ${target.hp}`)

        if (target.hp <= 0) {
            io.to(targetId).emit('preyCaught')
            io.to(code).emit('playerEliminated', { id: targetId })

            // Check if ALL prey caught
            const alivePrey = lobby.players.filter(p => p.role === 'prey' && p.hp > 0)
            if (alivePrey.length === 0) {
                io.to(code).emit('gameOver', { winner: 'hunter' })
                console.log(`[GAME] Hunter wins in ${code} — all prey caught!`)
            }
        }
    })

    socket.on('healthPickup', ({ pickupIndex }) => {
        // Broadcast to all clients to remove the pickup
        socket.to(socket.lobbyCode).emit('healthPickedUp', { id: socket.id, pickupIndex })
    })

    socket.on('caughtPrey', () => {
        io.to(socket.lobbyCode).emit('preyCaught')
        io.to(socket.lobbyCode).emit('gameOver', { winner: 'hunter' })
        console.log(`[GAME] Hunter caught Prey in ${socket.lobbyCode}`)
    })

    socket.on('preyEscaped', () => {
        const code = socket.lobbyCode
        const lobby = lobbies[code]
        if (!lobby) return

        io.to(code).emit('playerEscaped', { id: socket.id })

        // Check if all living prey have escaped (simplified: broadcast end)
        const alivePrey = lobby.players.filter(p => p.role === 'prey' && p.hp > 0 && p.id !== socket.id)
        if (alivePrey.length === 0) {
            io.to(code).emit('gameOver', { winner: 'prey' })
            console.log(`[GAME] All prey escaped in ${code}`)
        }
    })

    // --- Cleanup ---
    socket.on('disconnect', () => {
        const code = socket.lobbyCode
        if (code && lobbies[code]) {
            const lobby = lobbies[code]
            lobby.players = lobby.players.filter(p => p.id !== socket.id)
            io.to(code).emit('peerDisconnected', { id: socket.id })
            io.to(code).emit('playerCount', { count: lobby.players.length, max: lobby.maxPlayers })

            if (lobby.players.length === 0) {
                delete lobbies[code]
                console.log(`[-] Lobby ${code} closed (empty)`)
            } else {
                // If host left, assign new host
                if (lobby.host === socket.id) {
                    lobby.host = lobby.players[0].id
                    io.to(lobby.host).emit('youAreHost')
                }
                console.log(`[-] ${socket.id} left ${code} (${lobby.players.length} remain)`)
            }
        }
        console.log(`[-] Disconnected: ${socket.id}`)
    })
})

const PORT = Number(process.env.PORT || 3001)
server.listen(PORT, () => {
    console.log(`\n🎃 BIO-HORROR server running on :${PORT}\n`)
})
