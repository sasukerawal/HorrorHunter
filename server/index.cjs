// server/index.cjs — Bio-Horror Socket.IO Server (CommonJS for Node.js)
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
        const code = genCode()
        lobbies[code] = {
            players: [{ id: socket.id, role: 'hunter' }],
            state: 'waiting'
        }
        socket.join(code)
        socket.lobbyCode = code
        socket.emit('lobbyCreated', code)
        console.log(`[LOBBY] Created ${code} by ${socket.id}`)
    })

    socket.on('joinLobby', (code) => {
        const lobby = lobbies[code]
        if (!lobby) {
            socket.emit('lobbyError', 'Room not found')
            return
        }
        if (lobby.players.length >= 2) {
            socket.emit('lobbyError', 'Room is full')
            return
        }
        lobby.players.push({ id: socket.id, role: 'prey' })
        lobby.state = 'ingame'
        socket.join(code)
        socket.lobbyCode = code

        // Randomize who is hunter
        const isHostHunter = Math.random() > 0.5
        const hunterIdx = isHostHunter ? 0 : 1
        const preyIdx = isHostHunter ? 1 : 0

        const hunterSocket = lobby.players[hunterIdx].id
        const preySocket = lobby.players[preyIdx].id

        // Update stored roles
        lobby.players[hunterIdx].role = 'hunter'
        lobby.players[preyIdx].role = 'prey'

        console.log(`[GAME] Role Assignment for ${code}:`)
        console.log(`   - Hunter: ${hunterSocket} (${isHostHunter ? 'Host' : 'Joiner'})`)
        console.log(`   - Prey:   ${preySocket} (${isHostHunter ? 'Joiner' : 'Host'})`)

        // Send role DIRECTLY to each client
        io.to(hunterSocket).emit('yourRole', { role: 'hunter', peerId: preySocket })
        io.to(preySocket).emit('yourRole', { role: 'prey', peerId: hunterSocket })

        // Also keep gameStart for UI purposes
        io.to(code).emit('gameStart', { hunter: hunterSocket, prey: preySocket })
        console.log(`[LOBBY] ${code} started.`)
    })

    // --- Gameplay Events ---
    socket.on('playerMove', (data) => {
        // Broadcast position/rotation to the other player in the room
        socket.to(socket.lobbyCode).emit('peerMove', { id: socket.id, ...data })
    })

    socket.on('fearUpdate', (data) => {
        // Broadcast prey fear level to hunter
        socket.to(socket.lobbyCode).emit('peerFear', { id: socket.id, fear: data.fear, bpm: data.bpm })
    })

    socket.on('netFired', (data) => {
        // Hunter fires net gun — broadcast ray hit result to prey
        socket.to(socket.lobbyCode).emit('netHit', { ...data })
    })

    socket.on('caughtPrey', () => {
        io.to(socket.lobbyCode).emit('preyCaught')
        io.to(socket.lobbyCode).emit('gameOver', { winner: 'hunter' })
        console.log(`[GAME] Hunter caught Prey in ${socket.lobbyCode}`)
    })

    socket.on('preyEscaped', () => {
        io.to(socket.lobbyCode).emit('gameOver', { winner: 'prey' })
        console.log(`[GAME] Prey escaped in ${socket.lobbyCode}`)
    })

    // --- Cleanup ---
    socket.on('disconnect', () => {
        const code = socket.lobbyCode
        if (code && lobbies[code]) {
            io.to(code).emit('peerDisconnected')
            delete lobbies[code]
            console.log(`[-] Lobby ${code} closed`)
        }
        console.log(`[-] Disconnected: ${socket.id}`)
    })
})

const PORT = 3001
server.listen(PORT, () => {
    console.log(`\n🎃 BIO-HORROR server running on :${PORT}\n`)
})
