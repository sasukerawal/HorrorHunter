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
import { Biometrics } from './biometrics.js'
import { AssetManager } from './assets.js'
import { VoiceChat } from './voice.js'
import * as THREE from 'three'

const socket = io()

const engine = new Engine()
const hud = new HUD()
const lobby = new Lobby(socket)
const audio = new AudioSystem()
const biometrics = new Biometrics()
const voice = new VoiceChat(socket, audio)

let player = null
let netGun = null
let viewmodel = null
let fearSystem = null
let role = 'prey'
let peers = []         // { id, role } from server
let gameRunning = false
let elapsed = 0
let extractionEmergencyTriggered = false

const CATCH_DISTANCE = 1.8
const CATCH_FOV = 0.7
const JUMPSCARE_DISTANCE = 2.4
const JUMPSCARE_COOLDOWN = 18

let extractionTimer = 0
const EXTRACTION_REQUIRED = 5

// Peer state mirrored from socket
let peerFear = 0
let peerBPM  = 75
const doorPromptPos  = new THREE.Vector3()
const _catchToPrey   = new THREE.Vector3()
const _catchFacing   = new THREE.Vector3()
let jumpscareCooldown = 0

// E (interact), F (flashlight), V (hold-to-talk) — key edge/hold handlers
let eKeyPressed = false
let fKeyPressed = false
document.addEventListener('keydown', (e) => {
    if (e.repeat) return
    if (e.code === 'KeyE') eKeyPressed = true
    if (e.code === 'KeyF') fKeyPressed = true
    if (e.code === 'KeyV') voice.pttHeld(true)
})
document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyV') voice.pttHeld(false)
})

voice.onPanicCue = (_fromId, type = 'panic') => {
    const dist = player ? player.getPeerDistance() : Infinity
    if (dist > 22) return
    hud.showVoicePanicPulse()
    audio.playVoicePanicCue()
    if (player) player.triggerShake(type === 'breathing' ? 0.018 : 0.035)
}

// ─── GAME START ───
lobby.onGameStart = async (assignedRole, assignedPeers) => {
    role = assignedRole
    peers = assignedPeers  // array of { id, role }

    audio.init()
    audio.startAmbientDrone()

    // Try to init biometrics (will request camera permission)
    biometrics.init()
    voice.start(role, peers)

    // Show loading percentage while assets load
    const loadingBar = document.getElementById('loading-bar')
    const loadingPct = document.getElementById('loading-pct')
    if (loadingBar) loadingBar.style.display = 'block'
    if (loadingPct) loadingPct.textContent = '0%'

    // Pre-load all GLB models before building the map
    const assetManager = new AssetManager()
    await assetManager.loadAll()
    if (loadingPct) loadingPct.textContent = '50%'

    const canvas = document.getElementById('game-canvas')
    engine.init(canvas, assetManager)
    if (loadingPct) loadingPct.textContent = '80%'

    engine.onLoadComplete = () => {
        if (loadingPct) loadingPct.textContent = '100%'
        if (loadingBar) loadingBar.style.display = 'none'
        player = new Player(engine.camera, engine)

        const spawn = role === 'hunter'
            ? engine.mapData?.spawnHunter
            : engine.mapData?.spawnPrey
        player.setRole(role, spawn)
        engine.setRole(role)

        // 1v1: whichever peer exists has the opposite role — track it so the
        // prey can hide the hunter's body when their flashlight is off.
        player.peerRole = peers[0]?.role ?? null

        fearSystem = new FearSystem()
        viewmodel = new Viewmodel(engine.camera, role)

        if (role === 'hunter') {
            netGun = new NetGun(engine.camera, engine, socket, audio)
            // Set all prey meshes for hitscan targeting
            netGun.setPreyMeshes([player.peerMesh])
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
        setupMobileControls()
        gameLoop()           // starts RAF chain; loop noop's until gameRunning = true
        showControlsIntro(role)  // shows 3-second briefing then sets gameRunning = true
    }
}

// ─── SOCKET EVENTS ───
socket.on('peerMove', (data) => {
    if (player) player.updatePeer(data)
    if (netGun && data.isPhasing !== undefined) netGun.setPeerPhasing(!!data.isPhasing)
})

socket.on('doorToggle', ({ x, z, isOpen }) => {
    const changed = engine.applyRemoteDoor(x, z, isOpen)
    if (changed) {
        audio.playDoorCreak()
        audio.playDoorThud(0)
    }
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
            audio.playDamageTaken()
            if (player) {
                const isDead = player.takeDamage(1)
                hud.setHP(player.getHP(), player.getMaxHP())
                if (fearSystem) fearSystem.hunterDistance = Math.min(fearSystem.hunterDistance, 3)

                if (isDead) {
                    gameRunning = false
                    socket.emit('caughtPrey')
                    audio.playGameOver('hunter')
                    hud.showGameOver('hunter')
                    _spawnCaughtNet(engine.camera, null)
                }
            }
        }
    }
})

socket.on('preyHP', ({ id, hp }) => {
    // Could display other prey HP in multi-player
    console.log(`[HP] ${id}: ${hp} HP remaining`)
})

socket.on('preyCaught', () => {
    if (role === 'prey') {
        gameRunning = false
        audio.playGameOver('hunter')
        hud.showGameOver('hunter')
        _spawnCaughtNet(engine.camera, null)
    }
})

socket.on('playerEliminated', ({ id }) => {
    console.log(`[GAME] Player ${id} eliminated`)
})

socket.on('playerEscaped', ({ id }) => {
    console.log(`[GAME] Player ${id} escaped!`)
})

socket.on('healthPickedUp', ({ id, pickupIndex }) => {
    // Another player picked up a health item — remove it locally
    const hp = engine.healthPickups[pickupIndex]
    if (hp && !hp.collected) {
        hp.collected = true
        hp.mesh.visible = false
    }
})

socket.on('gameOver', ({ winner }) => {
    gameRunning = false
    audio.playGameOver(winner)
    hud.showGameOver(winner)
})

socket.on('peerDisconnected', ({ id }) => {
    console.log(`[GAME] Peer ${id} disconnected`)
    // In multi-player, the game continues if other players remain
})

let fearSyncTimer = 0
let catchCheckTimer = 0
let moveEmitTimer = 0
const systemTimers = { voice: 0, bpm: 0 }
let cachedPeerLineOfSight = true
const losFrom = new THREE.Vector3()
const losTo   = new THREE.Vector3()
const losDir  = new THREE.Vector3()
const _spatialFwd = new THREE.Vector3()
const _spatialUp  = new THREE.Vector3()

function checkHunterCatch() {
    if (role !== 'hunter' || !player) return
    // Cannot catch a phasing prey or one inside a locker
    if (player.peerIsPhasing || player.peerIsHiding) return
    const dist = player.getPeerDistance()
    if (dist > CATCH_DISTANCE) return
    _catchToPrey.subVectors(player.peerPosition, player.position).normalize()
    engine.camera.getWorldDirection(_catchFacing)
    if (_catchFacing.dot(_catchToPrey) >= CATCH_FOV) {
        // In HP mode, proximity catch is optional — net is the primary weapon
        // But we can still do a melee grab at very close range
        if (dist < 1.0) {
            socket.emit('netHitConfirm', { targetId: peers.find(p => p.role === 'prey')?.id })
        }
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

function triggerHunterJumpscare() {
    if (role !== 'hunter' || !player || jumpscareCooldown > 0) return
    jumpscareCooldown = JUMPSCARE_COOLDOWN
    audio.playJumpscareStinger()
    hud.showJumpscare(2000, Math.random() > 0.5 ? 1 : 0)
    player.stunHunter(2.0)
    player.shakeCamera(2.0, 0.32)
    engine.forceFlashlightOff(2.0)
    hud.setFlashlightStatus(false)
}

// ─── CONTROLS INTRO (3-second role briefing before game starts) ───
function showControlsIntro(assignedRole) {
    const overlay = document.getElementById('controls-intro')
    if (!overlay) { gameRunning = true; return }

    const DATA = {
        prey: {
            title:     'YOU ARE THE PREY',
            color:     '#00ffcc',
            obj:       'Survive 3 minutes · Reach extraction when time runs out',
            controls: [
                ['WASD / L. Stick',  'Move'],
                ['Mouse / R. Stick', 'Look'],
                ['SPACE / A',        'Jump'],
                ['SHIFT / LB',       'Sprint'],
                ['E / B',            'Interact · Hide in Locker'],
                ['Q / X',            'Phase Shift'],
                ['V (hold)',         'Voice Chat'],
            ],
            abilities: [
                ['⚡ PHASE SHIFT [Q / X]', 'Vanish for ~1 sec — hunter net cannot tag you'],
                ['🚪 HIDE [E / B]',        'Conceal yourself inside lockers'],
                ['💉 HEALTH PICKUPS',      'Red syringes scattered around the map restore HP'],
            ],
        },
        hunter: {
            title:     'YOU ARE THE HUNTER',
            color:     '#ff003c',
            obj:       'Catch every Prey before time runs out',
            controls: [
                ['WASD / L. Stick',    'Move'],
                ['Mouse / R. Stick',   'Look'],
                ['SPACE / A',          'Jump'],
                ['SHIFT / LB',         'Sprint'],
                ['CLICK / R. Trigger', 'Fire Net Gun'],
                ['F / Y',              'Toggle Flashlight'],
                ['E / B',              'Interact'],
                ['V (hold)',           'Voice Chat'],
            ],
            abilities: [
                ['🎯 NET GUN [CLICK]',     'Fire nets to catch prey — their fear widens the aim cone'],
                ['🔦 FLASHLIGHT [F / Y]',  'Illuminate prey — spikes BPM and fear level'],
                ['👁 BIOMETRIC FEED',       'Real-time prey fear % shown on your HUD top-right'],
            ],
        },
    }

    const d = DATA[assignedRole] ?? DATA.prey

    document.getElementById('ci-role').textContent  = d.title
    document.getElementById('ci-role').style.color  = d.color
    document.getElementById('ci-objective').textContent = d.obj

    document.getElementById('ci-body').innerHTML = `
        <div class="ci-section-label">CONTROLS</div>
        ${d.controls.map(([k, a]) => `
            <div class="ci-row">
                <span class="ci-key">${k}</span>
                <span class="ci-action">${a}</span>
            </div>`).join('')}
        <div class="ci-section-label">ABILITIES</div>
        ${d.abilities.map(([n, desc]) => `
            <div class="ci-ability-row">
                <div class="ci-ability-name">${n}</div>
                <div class="ci-ability-desc">${desc}</div>
            </div>`).join('')}
    `

    overlay.classList.remove('hidden')

    let count = 3
    const cdownEl = document.getElementById('ci-cdown')
    let dismissed = false

    const dismiss = () => {
        if (dismissed) return
        dismissed = true
        clearInterval(iv)
        overlay.classList.add('hidden')
        gameRunning = true
    }

    const iv = setInterval(() => {
        count--
        if (cdownEl) cdownEl.textContent = count
        if (count <= 0) dismiss()
    }, 1000)

    overlay.addEventListener('click', dismiss, { once: true })
}

// ─── MOBILE CONTROLS ───
function setupMobileControls() {
    if (!('ontouchstart' in window)) return
    const mc = document.getElementById('mobile-controls')
    if (!mc) return
    mc.classList.remove('hidden')

    // Show role-specific buttons
    if (role === 'prey') {
        document.getElementById('m-phase')?.classList.remove('hidden')
    } else {
        document.getElementById('m-flashlight')?.classList.remove('hidden')
    }

    // ── Left joystick ──
    const joyZone = document.getElementById('joy-left-zone')
    const joyKnob = document.getElementById('joy-left-knob')
    const JOY_R   = 52
    let joyId = -1, joyOx = 0, joyOy = 0

    joyZone?.addEventListener('touchstart', e => {
        e.preventDefault()
        if (joyId !== -1) return
        const t = e.changedTouches[0]
        joyId = t.identifier
        joyOx = t.clientX
        joyOy = t.clientY
    }, { passive: false })

    document.addEventListener('touchmove', e => {
        for (const t of e.changedTouches) {
            if (t.identifier !== joyId || !player) continue
            e.preventDefault()
            const dx = t.clientX - joyOx
            const dy = t.clientY - joyOy
            const len = Math.hypot(dx, dy) || 1
            const nx  = len > JOY_R ? (dx / len) * JOY_R : dx
            const ny  = len > JOY_R ? (dy / len) * JOY_R : dy
            if (joyKnob) joyKnob.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`
            const fx = dx / Math.max(len, JOY_R)
            const fy = dy / Math.max(len, JOY_R)
            player.keys.w = fy < -0.3
            player.keys.s = fy >  0.3
            player.keys.a = fx < -0.3
            player.keys.d = fx >  0.3
        }
    }, { passive: false })

    const endJoy = e => {
        for (const t of e.changedTouches) {
            if (t.identifier !== joyId) continue
            joyId = -1
            if (joyKnob) joyKnob.style.transform = 'translate(-50%, -50%)'
            if (player) { player.keys.w = player.keys.a = player.keys.s = player.keys.d = false }
        }
    }
    document.addEventListener('touchend',    endJoy)
    document.addEventListener('touchcancel', endJoy)

    // ── Right zone: look + tap-to-shoot ──
    const lookZone = document.getElementById('look-zone')
    let lookId = -1, lx = 0, ly = 0, lookMoved = 0, lookStart = 0

    lookZone?.addEventListener('touchstart', e => {
        e.preventDefault()
        if (lookId !== -1) return
        const t = e.changedTouches[0]
        lookId    = t.identifier
        lx        = t.clientX
        ly        = t.clientY
        lookMoved = 0
        lookStart = Date.now()
    }, { passive: false })

    lookZone?.addEventListener('touchmove', e => {
        e.preventDefault()
        for (const t of e.changedTouches) {
            if (t.identifier !== lookId || !player) continue
            const dx = t.clientX - lx
            const dy = t.clientY - ly
            lx = t.clientX
            ly = t.clientY
            lookMoved += Math.hypot(dx, dy)
            player.applyLookDelta(dx * 1.6, dy * 1.6)
        }
    }, { passive: false })

    lookZone?.addEventListener('touchend', e => {
        for (const t of e.changedTouches) {
            if (t.identifier !== lookId) continue
            lookId = -1
            // Tap = shoot for hunter (< 200ms, < 12px movement)
            if (role === 'hunter' && netGun && lookMoved < 12 && Date.now() - lookStart < 200) {
                netGun.tryFireFromMobile()
            }
        }
    })

    // ── Action buttons ──
    const mJump = document.getElementById('m-jump')
    mJump?.addEventListener('touchstart', e => {
        e.preventDefault()
        if (player) { player.keys.space = true; player.jumpBufferTimer = 0.15 }
    }, { passive: false })
    mJump?.addEventListener('touchend', e => { e.preventDefault(); if (player) player.keys.space = false }, { passive: false })

    document.getElementById('m-interact')?.addEventListener('touchstart', e => {
        e.preventDefault(); eKeyPressed = true
    }, { passive: false })

    document.getElementById('m-flashlight')?.addEventListener('touchstart', e => {
        e.preventDefault(); fKeyPressed = true
    }, { passive: false })

    document.getElementById('m-phase')?.addEventListener('touchstart', e => {
        e.preventDefault(); if (player) player.tryPhase(player.lastFear)
    }, { passive: false })

    const mPtt = document.getElementById('m-ptt')
    if (mPtt) {
        mPtt.classList.remove('hidden')
        mPtt.addEventListener('touchstart', e => { e.preventDefault(); voice.pttHeld(true) }, { passive: false })
        mPtt.addEventListener('touchend',   e => { e.preventDefault(); voice.pttHeld(false) }, { passive: false })
        mPtt.addEventListener('touchcancel',e => { e.preventDefault(); voice.pttHeld(false) }, { passive: false })
    }
}

// ─── GAME LOOP ───
function gameLoop() {
    requestAnimationFrame(gameLoop)
    if (!gameRunning) return

    const dt = Math.min(engine.clock.getDelta(), 0.05)
    elapsed += dt
    if (jumpscareCooldown > 0) jumpscareCooldown = Math.max(0, jumpscareCooldown - dt)

    // Update biometrics
    biometrics.update(dt)
    systemTimers.bpm += dt
    if (systemTimers.bpm >= 1.0) {
        systemTimers.bpm = 0
        biometrics.triggerEstimate()
        // Append active fear cascade source to biometrics status line
        if (fearSystem) hud.setFearSource(fearSystem.getActiveSource())
    }
    const biometricBPM      = biometrics.getBPM()
    const biometricEmotion  = biometrics.getEmotionFear()   // 0..1 facial fear, null if no face

    const manualBPM = hud.getManualBPM()
    if (role === 'prey' && player) {
        fearSystem.setHunterDistance(player.getPeerDistance())
        const manualOrNull = manualBPM && manualBPM !== 75 ? manualBPM : null
        // Pull voice-derived fear (RMS panic / breathing window) — fallback when face cam fails
        fearSystem.setVoiceFear(voice.getVoiceFear?.() ?? 0)
        // bpmConfidence drives the cascade tier: ≥0.35 = BPM leads; 0 = face/voice/proximity takes over
        fearSystem.update(dt, manualOrNull, biometricBPM, biometricEmotion, biometrics.confidence)
    }

    const localFear = fearSystem ? fearSystem.getFear() : 0
    const localBPM  = fearSystem ? fearSystem.getBPM() : 75
    const mods      = fearSystem ? fearSystem.getGameplayModifiers() : {}

    // Hunter's flashlight responds to PREY's biometrics
    const flashlightFear = role === 'prey' ? localFear : peerFear
    const flashlightBPM  = role === 'prey' ? localBPM  : peerBPM

    if (player) {
        player.update(dt, role === 'prey' ? mods : {}, localFear)
        if (netGun) {
            netGun.setAccuracy(mods.netAccuracy ?? 1)
            netGun.update(dt)
        }
        moveEmitTimer += dt
        if (moveEmitTimer >= 0.033) {   // 30 hz — halves serialization + network overhead vs every frame
            moveEmitTimer = 0
            socket.volatile.emit('playerMove', { ...player.serialize(), flashlightOn: engine.flashlightOn })
        }
    }

    if (viewmodel && player && !player.isHiding && !player.isPhasing) {
        viewmodel.update(dt, player.isMoving(), player.isDashing)
    }

    engine.update(elapsed, flashlightFear, dt, flashlightBPM)
    if (role === 'hunter') hud.setFlashlightStatus(engine.flashlightOn)

    // Occlusion culling only does visibility work on room changes or door state changes.
    if (player) {
        const currentRoom = engine.findRoomContaining(player.position)
        if (engine._occlusionDirty || player._lastOccRoomName !== currentRoom) {
            engine.updateOcclusion(player.position, currentRoom)
            player._lastOccRoomName = currentRoom
        }
    }

    // ─── Health pickup check (Prey only) ───
    if (role === 'prey' && player && player.getHP() < player.getMaxHP()) {
        const pickup = engine.checkHealthPickup(player.position)
        if (pickup) {
            player.heal(1)
            hud.setHP(player.getHP(), player.getMaxHP())
            audio.playHealthPickup()
            const idx = engine.healthPickups.indexOf(pickup)
            if (idx !== -1) socket.emit('healthPickup', { pickupIndex: idx })
        }
    }

    // Audio
    const peerDist = player ? player.getPeerDistance() : Infinity
    const moving   = player ? player.isMoving() : false

    systemTimers.voice += dt
    if (systemTimers.voice >= 0.1) {
        const voiceDt = systemTimers.voice
        systemTimers.voice = 0
        cachedPeerLineOfSight = true
        if (player && player.peerPosition && peerDist < 15) {
            losFrom.copy(player.position)
            losTo.copy(player.peerPosition)
            losDir.subVectors(losTo, losFrom).normalize()
            const hit = engine.raycastCollision({ origin: losFrom, direction: losDir })
            if (hit && hit.distance < peerDist) cachedPeerLineOfSight = false
        }
        voice.update(voiceDt, peerDist, cachedPeerLineOfSight)
        voice.applyFearDistortion(role === 'prey' ? localFear : peerFear)

        // HRTF 3D spatial audio — update listener pose + peer speaker position
        if (player && engine.camera) {
            engine.camera.getWorldDirection(_spatialFwd)
            _spatialUp.copy(engine.camera.up)
            voice.updateSpatialAudio(
                player.position,
                _spatialFwd,
                _spatialUp,
                player.peerPosition ?? null
            )
        }
        hud.setMicTransmit(voice.isTransmitting())
    }
    audio.update(dt, localFear, moving, localBPM, peerDist, cachedPeerLineOfSight)

    if (
        role === 'hunter' &&
        player &&
        peerDist < JUMPSCARE_DISTANCE &&
        !player.peerIsPhasing &&
        (peerFear > 0.55 || peerBPM >= 105)
    ) {
        triggerHunterJumpscare()
    }

    hud.update(dt, localFear, localBPM)

    // Fear glitch overlays
    const canvas = document.getElementById('game-canvas')
    if (canvas) {
        canvas.classList.toggle('fear-state', localFear > 0.7)
        canvas.classList.toggle('fear-glitch', localFear > 0.8)
        canvas.classList.toggle('high-panic', localFear > 0.8)
    }

    // Vignette: Prey gets BPM tunnel vision; Hunter gets weaker peer-fear radio bleed.
    hud.updatePanicVignette(role === 'prey' ? localBPM : peerBPM, role, peerFear)

    // Hunter crosshair bloom from prey's fear
    if (role === 'hunter' && netGun) hud.setCrosshairBloom(netGun.getBloom())

    // Stamina + Phase indicators (Prey)
    if (role === 'prey' && player) {
        hud.setStamina(player.getStamina())
        hud.setPhaseState(player.getPhaseCooldown(), player.isPhasing, localFear > 0.5)
    }

    // ─── Gamepad button edges (read + clear from player) ───
    if (player?.gpFlashJustPressed) {
        player.gpFlashJustPressed = false
        fKeyPressed = true
    }
    if (player?.gpInteractJustPressed) {
        player.gpInteractJustPressed = false
        eKeyPressed = true
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
                socket.emit('doorToggle', toggled)
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
            door.mesh.getWorldPosition(doorPromptPos)
            if (player.position.distanceTo(doorPromptPos) < 3) nearDoor = true
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

    if (player) engine.updateBlobShadows(player)

    engine.render(engine.scene, engine.camera)
}
