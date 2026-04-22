// src/main.js — Bootstrap and Game Loop
import { io } from 'socket.io-client'
import { Engine } from './engine.js'
import { Player } from './player.js'
import { NetGun } from './netgun.js'
import { FearSystem } from './fear.js'
import { HUD } from './hud.js'
import { Lobby } from './lobby.js'
import { AudioSystem } from './audio.js'
import { Viewmodel } from './viewmodel.js'
import * as THREE from 'three'

const socket = io()

const engine = new Engine()
const hud = new HUD()
const lobby = new Lobby(socket)
const audio = new AudioSystem()

let player = null
let netGun = null
let viewmodel = null
let fearSystem = null
let role = 'prey'
let peerId = null
let gameRunning = false
let elapsed = 0
let extractionEmergencyTriggered = false

const CATCH_DISTANCE = 1.8
const CATCH_FOV = 0.7

let extractionTimer = 0
const EXTRACTION_REQUIRED = 5

// Peer state mirrored from socket
let peerFear = 0
let peerBPM  = 75

// E (interact) and F (flashlight) — single key-edge handler
let eKeyPressed = false
let fKeyPressed = false
document.addEventListener('keydown', (e) => {
    if (e.repeat) return
    if (e.code === 'KeyE') eKeyPressed = true
    if (e.code === 'KeyF') fKeyPressed = true
})

// ─── GAME START ───
lobby.onGameStart = (assignedRole, assignedPeerId) => {
    role = assignedRole
    peerId = assignedPeerId

    audio.init()
    audio.startAmbientDrone()

    const canvas = document.getElementById('game-canvas')
    engine.init(canvas)

    engine.onLoadComplete = () => {
        player = new Player(engine.camera, engine)

        const spawn = role === 'hunter'
            ? engine.mapData?.spawnHunter
            : engine.mapData?.spawnPrey
        player.setRole(role, spawn)
        engine.setRole(role)

        fearSystem = new FearSystem()
        viewmodel = new Viewmodel(engine.camera, role)

        if (role === 'hunter') {
            netGun = new NetGun(engine.camera, engine, socket, audio)
            netGun.setPeerPlayerId(peerId)
            netGun.setPreyMesh(player.peerMesh)
            netGun.viewmodel = viewmodel
        }

        // Phase / hide hooks → visuals
        player.onPhaseStart = () => {
            const cv = document.getElementById('game-canvas')
            if (cv) cv.classList.add('phase-active')
            if (viewmodel) viewmodel.setOpacity(0.3)
            audio.playFootstep(0.6)
        }
        player.onPhaseEnd = () => {
            const cv = document.getElementById('game-canvas')
            if (cv) cv.classList.remove('phase-active')
            if (viewmodel) viewmodel.setOpacity(1.0)
        }
        player.onPhaseDenied = (reason) => {
            player.triggerShake(0.04)
            console.log(`[Phase] denied: ${reason}`)
        }
        player.onHideEnter = () => {
            audio.playDoorThud(0)
            if (viewmodel) viewmodel.setOpacity(0)
        }
        player.onHideExit  = () => {
            if (viewmodel) viewmodel.setOpacity(1.0)
        }

        hud.start(role)
        hud.setFlashlightStatus(engine.flashlightOn)
        gameRunning = true
        gameLoop()
    }
}

// ─── SOCKET EVENTS ───
socket.on('peerMove', (data) => {
    if (player) player.updatePeer(data)
    if (netGun) netGun.setPeerPhasing(!!data.isPhasing)
})

socket.on('peerFear', (data) => {
    peerFear = data.fear ?? 0
    peerBPM  = data.bpm  ?? 75
    if (role === 'hunter') {
        const el = document.getElementById('hud-peer-fear')
        if (el) el.textContent = `Prey fear: ${Math.round(peerFear * 100)}%`
        if (netGun) netGun.setPeerFear(peerFear)
    }
})

socket.on('netHit', (data) => {
    if (role === 'prey') {
        const didHitPrey = data.hit && data.hit.hitPrey
        if (didHitPrey) {
            const flash = document.getElementById('hit-flash')
            if (flash) {
                flash.style.opacity = '0.6'
                setTimeout(() => { flash.style.opacity = '0' }, 250)
            }
            audio.playNetHit()
            if (fearSystem) fearSystem.hunterDistance = Math.min(fearSystem.hunterDistance, 3)
        }
    }
})

socket.on('preyCaught', () => {
    gameRunning = false
    audio.playGameOver('hunter')
    hud.showGameOver('hunter')
    if (role === 'prey') _spawnCaughtNet(engine.camera, null)
})

socket.on('gameOver', ({ winner }) => {
    gameRunning = false
    audio.playGameOver(winner)
    hud.showGameOver(winner)
})

let fearSyncTimer = 0
let catchCheckTimer = 0

function checkHunterCatch() {
    if (role !== 'hunter' || !player) return
    // Cannot catch a phasing prey or one inside a locker
    if (player.peerIsPhasing || player.peerIsHiding) return
    const dist = player.getPeerDistance()
    if (dist > CATCH_DISTANCE) return
    const toPrey = player.peerPosition.clone().sub(player.position).normalize()
    const facing = new THREE.Vector3()
    engine.camera.getWorldDirection(facing)
    if (facing.dot(toPrey) >= CATCH_FOV) {
        gameRunning = false
        socket.emit('caughtPrey')
        audio.playGameOver('hunter')
        hud.showGameOver('hunter')
        if (player.peerMesh) _spawnCaughtNet(null, player.peerMesh)
    }
}

function _spawnCaughtNet(camera, peerMesh) {
    const netGeo = new THREE.SphereGeometry(0.65, 10, 10)
    const netMat = new THREE.MeshBasicMaterial({
        color: '#00ffcc', wireframe: true, transparent: true, opacity: 0.75,
    })
    const netMesh = new THREE.Mesh(netGeo, netMat)
    if (camera)   { netMesh.position.set(0, 0, -0.5); camera.add(netMesh) }
    if (peerMesh) { netMesh.position.set(0, 0.3, 0); peerMesh.add(netMesh) }
}

// ─── GAME LOOP ───
function gameLoop() {
    requestAnimationFrame(gameLoop)
    if (!gameRunning) return

    const dt = Math.min(engine.clock.getDelta(), 0.05)
    elapsed += dt

    const manualBPM = hud.getManualBPM()
    if (role === 'prey' && player) {
        fearSystem.setHunterDistance(player.getPeerDistance())
        fearSystem.update(dt, manualBPM && manualBPM !== 75 ? manualBPM : null)
    }

    const localFear = fearSystem ? fearSystem.getFear() : 0
    const localBPM  = fearSystem ? fearSystem.getBPM() : 75
    const mods      = fearSystem ? fearSystem.getGameplayModifiers() : {}

    // Hunter's flashlight responds to PREY's biometrics (it's the prey's heartbeat the hunter feels via the radio link)
    const flashlightFear = role === 'prey' ? localFear : peerFear
    const flashlightBPM  = role === 'prey' ? localBPM  : peerBPM

    if (player) {
        player.update(dt, role === 'prey' ? mods : {}, localFear)
        if (netGun) {
            netGun.setAccuracy(mods.netAccuracy ?? 1)
            netGun.update(dt)
        }
        socket.volatile.emit('playerMove', player.serialize())
    }

    if (viewmodel && player && !player.isHiding && !player.isPhasing) {
        viewmodel.update(dt, player.isMoving(), player.isDashing)
    }

    engine.update(elapsed, flashlightFear, dt, flashlightBPM)

    // Occlusion culling — only render player's room + adjacent open-door rooms
    if (player) engine.updateOcclusion(player.position)

    // Audio
    const peerDist = player ? player.getPeerDistance() : Infinity
    const moving   = player ? player.isMoving() : false

    let isLineOfSight = true
    if (player && player.peerPosition && peerDist < 15) {
        const fromPos = player.position.clone()
        const toPos   = player.peerPosition.clone()
        const dir = new THREE.Vector3().subVectors(toPos, fromPos).normalize()
        const ray = { origin: fromPos, direction: dir }
        const hit = engine.raycastCollision(ray)
        if (hit && hit.distance < peerDist) isLineOfSight = false
    }
    audio.update(dt, localFear, moving, localBPM, peerDist, isLineOfSight)

    hud.update(dt, localFear, localBPM)

    // Fear glitch overlays
    const canvas = document.getElementById('game-canvas')
    if (canvas) {
        canvas.classList.toggle('fear-state', localFear > 0.7)
        canvas.classList.toggle('fear-glitch', localFear > 0.8)
        canvas.classList.toggle('high-panic', localFear > 0.8)
    }

    // Vignette: Prey sees own fear darken; Hunter sees peer fear (radio bleed)
    hud.setVignetteFear(role === 'prey' ? localFear : peerFear)

    // Hunter crosshair bloom from prey's fear
    if (role === 'hunter' && netGun) hud.setCrosshairBloom(netGun.getBloom())

    // Stamina + Phase indicators (Prey)
    if (role === 'prey' && player) {
        hud.setStamina(player.getStamina())
        hud.setPhaseState(player.getPhaseCooldown(), player.isPhasing, localFear > 0.5)
    }

    // ─── F (flashlight) ───
    if (fKeyPressed) {
        fKeyPressed = false
        if (role === 'hunter' && player && !player.isHiding) {
            const on = engine.toggleFlashlight()
            hud.setFlashlightStatus(on)
        }
    }

    // ─── E (door OR locker) ───
    if (eKeyPressed && player) {
        eKeyPressed = false
        if (player.isHiding) {
            player.exitHide()
            audio.playDoorCreak()
        } else {
            const toggled = engine.tryInteractDoor(player.position)
            if (toggled) {
                audio.playDoorCreak()
                audio.playDoorThud(0)
                player.triggerShake(0.06)
            } else {
                const locker = engine.findNearestLocker(player.position)
                if (locker) player.enterHide(locker)
            }
        }
    }

    // Door / Hide proximity prompts
    const prompt = document.getElementById('interact-prompt')
    if (prompt && player) {
        let nearDoor = false
        engine.doors.forEach(door => {
            const dp = new THREE.Vector3()
            door.mesh.getWorldPosition(dp)
            if (player.position.distanceTo(dp) < 3) nearDoor = true
        })
        prompt.classList.toggle('visible', nearDoor && !player.isHiding)
    }
    if (player) {
        const nearLocker = engine.findNearestLocker(player.position) !== null
        hud.setHideHint(nearLocker || player.isHiding, player.isHiding)
    }

    // ─── Extraction (timer, emergency light + arrow) ───
    if (hud.timeLeft <= 0 && !extractionEmergencyTriggered) {
        extractionEmergencyTriggered = true
        engine.activateExtractionEmergency()
    }

    const extractHud  = document.getElementById('extraction-hud')
    const extractFill = document.getElementById('extraction-fill')

    if (role === 'prey' && player && hud.timeLeft <= 0) {
        const dir = engine.getExtractionDirection(player.position)
        hud.setExtractionArrow(true, dir, player.euler.y)

        const inZone = engine.isInExtractionZone(player.position)
        if (inZone) {
            extractionTimer += dt
            if (extractHud) {
                extractHud.classList.remove('hidden')
                if (extractFill) extractFill.style.width = `${Math.min(100, (extractionTimer / EXTRACTION_REQUIRED) * 100)}%`
            }
            if (extractionTimer >= EXTRACTION_REQUIRED) {
                gameRunning = false
                socket.emit('preyEscaped')
                audio.playGameOver('prey')
                hud.showGameOver('prey')
            }
        } else {
            extractionTimer = Math.max(0, extractionTimer - dt * 2)
            if (extractHud) extractHud.classList.add('hidden')
        }
    } else {
        hud.setExtractionArrow(false)
    }

    // Fear sync (Prey → Hunter)
    if (role === 'prey') {
        fearSyncTimer += dt
        if (fearSyncTimer >= 0.2) {
            fearSyncTimer = 0
            socket.emit('fearUpdate', { fear: localFear, bpm: localBPM })
        }
    }

    if (role === 'hunter') {
        catchCheckTimer += dt
        if (catchCheckTimer >= 0.1) {
            catchCheckTimer = 0
            checkHunterCatch()
        }
    }

    engine.render(engine.scene, engine.camera)
}
