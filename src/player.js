// src/player.js — FPS Player Controller (accel/friction physics, coyote, jump-buffer, wall-slide, phase, hide)
import * as THREE from 'three'

const COYOTE_TIME      = 0.10
const JUMP_BUFFER      = 0.15
const PHASE_DURATION   = 1.5
const PHASE_COOLDOWN   = 10.0
const PHASE_STAMINA    = 20
const STAMINA_REGEN    = 8     // per-second
const STAMINA_MAX      = 100
const HIDE_YAW_RANGE   = 0.35  // how far the player can pan inside a locker

export class Player {
    constructor(camera, engine) {
        this.camera = camera
        this.engine = engine

        this.position = new THREE.Vector3(0, 1.7, 0)
        this.velocity = new THREE.Vector3()
        this.role = 'prey'
        this.isOnGround = true
        this.isDashing = false
        this.dashTimer = 0
        this.dashCooldown = 0
        this.isLocked = false
        this.spawnSettleTimer = 0.4

        // Physics
        this.height    = 1.7
        this.radius    = 0.35
        this.gravity   = 18
        this.jumpSpeed = 7
        this.baseSpeed = 5
        this.speed     = this.baseSpeed
        // Acceleration model — terminal velocity = accel/friction along input direction
        this.groundFriction = 12
        this.airFriction    = 1.5
        this.groundAccelMul = 12   // accel = wishSpeed * groundAccelMul
        this.airAccelMul    = 4

        // Coyote / Jump-Buffer
        this.coyoteTimer    = 0
        this.jumpBufferTimer = 0

        // Wall-slide
        this.wallContact = false

        // Phase ability
        this.isPhasing      = false
        this.phaseTimer     = 0
        this.phaseCooldown  = 0
        this.stamina        = STAMINA_MAX

        // Hiding (in a locker)
        this.isHiding       = false
        this.hideYawCenter  = 0
        this.hideExitPos    = null
        this._activeLocker  = null

        // HP system
        this.hp    = 3
        this.maxHp = 3

        // Camera shake
        this.shakeAmount    = 0
        this.shakeDecay     = 5
        this._groundRaycaster = new THREE.Raycaster()
        this._downVector      = new THREE.Vector3(0, -1, 0)
        this._moveDir         = new THREE.Vector3()
        this._camForward      = new THREE.Vector3()
        this._camRight        = new THREE.Vector3()
        this._inputForce      = new THREE.Vector3()
        this._delta           = new THREE.Vector3()
        this._groundMeshes    = []

        // Mouse look
        this.euler = new THREE.Euler(0, 0, 0, 'YXZ')
        this.mouseSensitivity = 0.002

        this.keys = { w: false, a: false, s: false, d: false, space: false, shift: false }

        // Peer
        this.peerPosition = new THREE.Vector3(0, 1.7, -5)
        this.peerMesh = null
        this.peerIsPhasing = false
        this.peerIsHiding  = false

        // Phase / Hide event hooks (main.js wires these)
        this.onPhaseStart = null
        this.onPhaseEnd   = null
        this.onHideEnter  = null
        this.onHideExit   = null
        this.onJump       = null
        this.onPhaseDenied = null  // (reason: 'fear' | 'cooldown' | 'stamina')

        this._setupInput()
        this._createPeerMesh()
    }

    _setupInput() {
        document.addEventListener('click', () => {
            if (document.getElementById('ui-overlay').classList.contains('hidden')) {
                document.body.requestPointerLock()
            }
        })

        document.addEventListener('pointerlockchange', () => {
            this.isLocked = document.pointerLockElement === document.body
        })

        document.addEventListener('mousemove', (e) => {
            if (!this.isLocked) return
            this.euler.setFromQuaternion(this.camera.quaternion)
            this.euler.y -= e.movementX * this.mouseSensitivity
            this.euler.x -= e.movementY * this.mouseSensitivity
            this.euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.euler.x))
            // Locker yaw clamp
            if (this.isHiding) {
                const min = this.hideYawCenter - HIDE_YAW_RANGE
                const max = this.hideYawCenter + HIDE_YAW_RANGE
                if (this.euler.y < min) this.euler.y = min
                if (this.euler.y > max) this.euler.y = max
            }
            this.camera.quaternion.setFromEuler(this.euler)
        })

        document.addEventListener('keydown', (e) => {
            const k = e.code
            if (this.isHiding) {
                // Lock movement keys while hiding (E in main.js exits)
                if (k === 'Space') e.preventDefault()
                return
            }
            if (k === 'KeyW') this.keys.w = true
            if (k === 'KeyA') this.keys.a = true
            if (k === 'KeyS') this.keys.s = true
            if (k === 'KeyD') this.keys.d = true
            if (k === 'Space') {
                e.preventDefault()
                this.keys.space = true
                this.jumpBufferTimer = JUMP_BUFFER
            }
            if (k === 'ShiftLeft' || k === 'ShiftRight') this.keys.shift = true
            if (k === 'KeyQ' && this.role === 'prey') this.tryPhase()
        })

        document.addEventListener('keyup', (e) => {
            const k = e.code
            if (k === 'KeyW') this.keys.w = false
            if (k === 'KeyA') this.keys.a = false
            if (k === 'KeyS') this.keys.s = false
            if (k === 'KeyD') this.keys.d = false
            if (k === 'Space') this.keys.space = false
            if (k === 'ShiftLeft' || k === 'ShiftRight') this.keys.shift = false
        })
    }

    _createPeerMesh() {
        // Peer mesh is created after role is set; use a placeholder group now
        this.peerMesh = new THREE.Group()
        this.peerMesh.visible = false
        this.engine.scene.add(this.peerMesh)
    }

    /** Called after setRole — rebuilds the peer mesh for the opponent's appearance */
    _buildPeerModel() {
        // Remove old mesh children
        while (this.peerMesh.children.length) this.peerMesh.remove(this.peerMesh.children[0])

        const peerIsPrey = this.role === 'hunter'  // our peer is the opposite role

        if (peerIsPrey) {
            this._buildCatPeer()
        } else {
            this._buildHumanoidPeer()
        }
    }

    /** Humanoid hunter model — torso, head, arms, legs */
    _buildHumanoidPeer() {
        const matBody = new THREE.MeshStandardMaterial({ color: '#661111', roughness: 0.7, metalness: 0.2, transparent: true })
        const matSkin  = new THREE.MeshStandardMaterial({ color: '#aa8866', roughness: 0.8, transparent: true })
        const matDark  = new THREE.MeshStandardMaterial({ color: '#333333', roughness: 0.6, metalness: 0.4, transparent: true })

        // Torso
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), matBody)
        torso.position.set(0, 0.1, 0)
        torso.castShadow = true
        this.peerMesh.add(torso)

        // Head
        this.peerHead = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.35, 0.32), matSkin)
        this.peerHead.position.set(0, 0.65, 0)
        this.peerHead.castShadow = true
        this.peerMesh.add(this.peerHead)

        // Eyes (red emissive)
        const eyeMat = new THREE.MeshBasicMaterial({ color: '#ff2200' })
        const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), eyeMat)
        eyeL.position.set(-0.08, 0.68, -0.16)
        this.peerMesh.add(eyeL)
        const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), eyeMat)
        eyeR.position.set(0.08, 0.68, -0.16)
        this.peerMesh.add(eyeR)

        // Arms
        for (const side of [-1, 1]) {
            const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.6, 6), matBody)
            arm.position.set(side * 0.35, -0.0, 0)
            arm.castShadow = true
            this.peerMesh.add(arm)
        }

        // Legs
        for (const side of [-1, 1]) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.7, 6), matDark)
            leg.position.set(side * 0.15, -0.6, 0)
            leg.castShadow = true
            this.peerMesh.add(leg)
        }

        // Flashlight prop on right arm
        const flProp = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.2, 6), matDark)
        flProp.rotation.x = Math.PI / 2
        flProp.position.set(0.35, -0.1, -0.15)
        this.peerMesh.add(flProp)

        this.peerNose = null  // no nose on humanoid
    }

    /** Cat-like prey model — body, head with ears, tail, four legs */
    _buildCatPeer() {
        const matBody = new THREE.MeshStandardMaterial({ color: '#1133cc', roughness: 0.6, metalness: 0.1, transparent: true })
        const matAccent = new THREE.MeshStandardMaterial({ color: '#0088ff', roughness: 0.5, transparent: true })
        const matEye = new THREE.MeshBasicMaterial({ color: '#00ffcc' })

        // Body (small low prey silhouette)
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), matBody)
        body.scale.set(1, 0.55, 1.35)
        body.position.set(0, -1.18, 0)
        body.castShadow = false
        this.peerMesh.add(body)

        // Head
        this.peerHead = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), matBody)
        this.peerHead.position.set(0, -1.08, -0.28)
        this.peerHead.castShadow = false
        this.peerMesh.add(this.peerHead)

        // Ears (cones)
        for (const side of [-1, 1]) {
            const ear = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.09, 4), matAccent)
            ear.position.set(side * 0.065, -0.94, -0.27)
            ear.rotation.z = side * 0.2
            this.peerMesh.add(ear)
        }

        // Eyes (glowing cyan)
        const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.018, 5, 5), matEye)
        eyeL.position.set(-0.04, -1.07, -0.38)
        this.peerMesh.add(eyeL)
        const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.018, 5, 5), matEye)
        eyeR.position.set(0.04, -1.07, -0.38)
        this.peerMesh.add(eyeR)

        // Legs (4 thin cylinders)
        const legPositions = [[-0.08, -0.16], [0.08, -0.16], [-0.08, 0.14], [0.08, 0.14]]
        for (const [lx, lz] of legPositions) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.015, 0.22, 5), matAccent)
            leg.position.set(lx, -1.36, lz)
            leg.castShadow = false
            this.peerMesh.add(leg)
        }

        // Tail (curved segments)
        const tailMat = matAccent
        for (let i = 0; i < 5; i++) {
            const seg = new THREE.Mesh(new THREE.SphereGeometry(0.022 - i * 0.0025, 5, 5), tailMat)
            seg.position.set(0, -1.17 + i * 0.035, 0.28 + i * 0.055)
            this.peerMesh.add(seg)
        }

        this.peerNose = null  // no separate nose on cat
    }

    setRole(role, spawnPos = null) {
        this.role = role
        const peerIsPrey = role === 'hunter'
        if (this.peerMesh) {
            this._buildPeerModel()
        }
        const map = this.engine.mapData
        if (spawnPos) {
            this.position.copy(spawnPos)
        } else if (role === 'hunter') {
            this.position.copy(map?.spawnHunter ?? new THREE.Vector3(0, 1.7, 0))
        } else {
            this.position.copy(map?.spawnPrey ?? new THREE.Vector3(0, 1.7, 21))
        }
        this.position.y = 1.7
        if (this._isInsideAnyCollider(this.position)) {
            const safe = this._findNearestSafePos(this.position)
            if (safe) {
                safe.y = 1.7
                this.position.copy(safe)
            }
        }
        this.velocity.set(0, 0, 0)
        this.isOnGround = true
        this.spawnSettleTimer = 0.4
        this.camera.position.copy(this.position)
        console.log(`[Player] role=${role} spawn=(${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)})`)
    }

    triggerShake(amount = 0.08) {
        this.shakeAmount = Math.max(this.shakeAmount, amount)
    }

    // ─── PHASE ABILITY (Prey only) ──────────────────────────────────
    tryPhase(currentFear = null) {
        if (this.role !== 'prey' || this.isPhasing || this.isHiding) return false
        if (this.phaseCooldown > 0) {
            if (this.onPhaseDenied) this.onPhaseDenied('cooldown')
            return false
        }
        if (this.stamina < PHASE_STAMINA) {
            if (this.onPhaseDenied) this.onPhaseDenied('stamina')
            return false
        }
        // Fear gate — main.js sets this.lastFear so the player can self-check without a tight coupling
        const fear = currentFear ?? this.lastFear ?? 0
        if (fear <= 0.5) {
            if (this.onPhaseDenied) this.onPhaseDenied('fear')
            return false
        }
        this.isPhasing     = true
        this.phaseTimer    = PHASE_DURATION
        this.phaseCooldown = PHASE_COOLDOWN
        this.stamina       = Math.max(0, this.stamina - PHASE_STAMINA)
        if (this.onPhaseStart) this.onPhaseStart()
        return true
    }

    _endPhase() {
        // Safety check: if stuck inside a wall, push to nearest empty cell
        if (this._isInsideAnyCollider(this.position)) {
            const safe = this._findNearestSafePos(this.position)
            if (safe) this.position.copy(safe)
        }
        this.isPhasing  = false
        this.phaseTimer = 0
        if (this.onPhaseEnd) this.onPhaseEnd()
    }

    _isInsideAnyCollider(pos) {
        const FOOT_LIFT = 0.1
        const playerBox = new THREE.Box3(
            new THREE.Vector3(pos.x - this.radius, pos.y - this.height + FOOT_LIFT, pos.z - this.radius),
            new THREE.Vector3(pos.x + this.radius, pos.y + 0.1, pos.z + this.radius)
        )
        for (const { box } of this.engine.getCollisionEntriesNear(pos)) {
            if (box.max.y <= pos.y - this.height + 0.05) continue
            if (box.min.y >= pos.y + 0.05) continue
            if (playerBox.intersectsBox(box)) return true
        }
        return false
    }

    _findNearestSafePos(from) {
        // Spiral search outward in xz for an empty spot
        for (let r = 0.5; r <= 4.0; r += 0.5) {
            for (let a = 0; a < 16; a++) {
                const ang = (a / 16) * Math.PI * 2
                const test = from.clone()
                test.x += Math.cos(ang) * r
                test.z += Math.sin(ang) * r
                if (!this._isInsideAnyCollider(test)) return test
            }
        }
        return null
    }

    // ─── HIDE (Locker) ──────────────────────────────────────────────
    enterHide(locker) {
        if (this.isHiding) return false
        this.isHiding      = true
        this._activeLocker = locker
        this.hideExitPos   = this.position.clone()
        this.position.copy(locker.position)
        this.position.y    = 1.7
        this.hideYawCenter = locker.lockedYaw
        this.euler.y       = locker.lockedYaw
        this.camera.quaternion.setFromEuler(this.euler)
        this.velocity.set(0, 0, 0)
        if (this.onHideEnter) this.onHideEnter()
        return true
    }

    exitHide() {
        if (!this.isHiding) return
        if (this.hideExitPos) this.position.copy(this.hideExitPos)
        this.isHiding      = false
        this._activeLocker = null
        this.hideExitPos   = null
        if (this.onHideExit) this.onHideExit()
    }

    // ─── PER-FRAME ──────────────────────────────────────────────────
    update(dt, fearModifiers = {}, currentFear = 0) {
        this.lastFear = currentFear

        // Stamina regen
        if (this.stamina < STAMINA_MAX) {
            this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt)
        }
        if (this.phaseCooldown > 0) this.phaseCooldown = Math.max(0, this.phaseCooldown - dt)

        // Phase tick
        if (this.isPhasing) {
            this.phaseTimer -= dt
            if (this.phaseTimer <= 0) this._endPhase()
        }

        // Frozen while hiding — only camera-shake decays
        if (this.isHiding) {
            this._applyCameraShake(dt)
            this.camera.position.copy(this.position)
            return
        }

        const wishSpeed = this.baseSpeed * (fearModifiers.preySpeed ?? 1)

        // Movement follows yaw only, so looking straight up/down never kills horizontal input.
        const dir = this._moveDir.set(0, 0, 0)
        const yaw = this.euler.y
        const camForward = this._camForward.set(-Math.sin(yaw), 0, -Math.cos(yaw))
        const camRight   = this._camRight.set(Math.cos(yaw), 0, -Math.sin(yaw))

        if (this.keys.w) dir.addScaledVector(camForward,  1)
        if (this.keys.s) dir.addScaledVector(camForward, -1)
        if (this.keys.a) dir.addScaledVector(camRight,   -1)
        if (this.keys.d) dir.addScaledVector(camRight,    1)
        if (dir.lengthSq() > 0) dir.normalize()

        // Dash (Prey only, disabled if fear too high)
        if (this.role === 'prey' && this.keys.shift && this.dashCooldown <= 0 && (fearModifiers.dashEnabled ?? true)) {
            this.isDashing = true
            this.dashTimer = 0.3
            this.dashCooldown = 1.5
        }
        let currentSpeed = wishSpeed
        if (this.isDashing) {
            currentSpeed = wishSpeed * 2.5
            this.dashTimer -= dt
            if (this.dashTimer <= 0) this.isDashing = false
        }
        if (this.dashCooldown > 0) this.dashCooldown -= dt

        // ─── ACCEL/FRICTION INTEGRATION (formula: v += (input*accel - v*friction) * dt) ───
        const friction  = this.isOnGround ? this.groundFriction : this.airFriction
        const accelMul  = this.isOnGround ? this.groundAccelMul : this.airAccelMul
        const accelMag  = currentSpeed * accelMul
        const inputForce = this._inputForce.copy(dir).multiplyScalar(accelMag)
        const dragX = this.velocity.x * friction
        const dragZ = this.velocity.z * friction
        this.velocity.x += (inputForce.x - dragX) * dt
        this.velocity.z += (inputForce.z - dragZ) * dt

        // Snap tiny residuals to zero so we stop cleanly
        if (Math.abs(this.velocity.x) < 0.02) this.velocity.x = 0
        if (Math.abs(this.velocity.z) < 0.02) this.velocity.z = 0

        // ─── COYOTE TIME / JUMP BUFFER ───
        if (this.spawnSettleTimer > 0) {
            this.spawnSettleTimer -= dt
            this.velocity.y = 0
            this.position.y = 1.7
            this.coyoteTimer = COYOTE_TIME
            this.jumpBufferTimer = 0
        } else {
            if (this.isOnGround) {
                this.coyoteTimer = COYOTE_TIME
            } else {
                this.coyoteTimer = Math.max(0, this.coyoteTimer - dt)
            }
            // Jump request — buffered Space + within coyote window
            if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
                this.velocity.y       = this.jumpSpeed
                this.isOnGround       = false
                this.coyoteTimer      = 0
                this.jumpBufferTimer  = 0
                if (this.onJump) this.onJump()
            } else if (this.jumpBufferTimer > 0) {
                this.jumpBufferTimer -= dt
            }

            // Gravity (with wall-slide reduction)
            if (!this.isOnGround) {
                const slide = (this.wallContact && this.velocity.y < 0) ? 0.5 : 1.0
                this.velocity.y -= this.gravity * slide * dt
            } else {
                this.velocity.y = Math.max(0, this.velocity.y)
            }
        }

        // Move & collide
        const delta = this._delta.copy(this.velocity).multiplyScalar(dt)
        this._moveAndCollide(delta)

        // Camera follows
        this.camera.position.copy(this.position)
        this._applyCameraShake(dt)

        this._groundCheck()
    }

    _applyCameraShake(dt) {
        if (this.shakeAmount > 0) {
            this.camera.position.x += (Math.random() - 0.5) * this.shakeAmount
            this.camera.position.y += (Math.random() - 0.5) * this.shakeAmount
            this.camera.position.z += (Math.random() - 0.5) * this.shakeAmount * 0.4
            this.shakeAmount = Math.max(0, this.shakeAmount - this.shakeDecay * dt)
        }
    }

    _moveAndCollide(delta) {
        const nextPos = this.position.clone().add(delta)

        // Phase: ignore all AABB collision but keep world bounds + ground
        if (this.isPhasing) {
            this.position.copy(nextPos)
            this.position.x = Math.max(-50, Math.min(50, this.position.x))
            this.position.z = Math.max(-50, Math.min(50, this.position.z))
            this.wallContact = false
            return
        }

        if (this.role === 'hunter' && this.engine.ventZones?.length) {
            const testPt = new THREE.Vector3(nextPos.x, 0.5, nextPos.z)
            for (const zone of this.engine.ventZones) {
                if (zone.containsPoint(testPt)) return
            }
        }

        const FOOT_LIFT = 0.1
        const collisionCandidates = this.engine.getCollisionEntriesNear(nextPos)
        const playerBox = new THREE.Box3(
            new THREE.Vector3(nextPos.x - this.radius, nextPos.y - this.height + FOOT_LIFT, nextPos.z - this.radius),
            new THREE.Vector3(nextPos.x + this.radius, nextPos.y + 0.1, nextPos.z + this.radius)
        )

        let blocked = false
        for (const { box } of collisionCandidates) {
            if (box.max.y <= nextPos.y - this.height + 0.05) continue
            if (box.min.y >= nextPos.y + 0.05) continue
            if (playerBox.intersectsBox(box)) { blocked = true; break }
        }

        this.wallContact = false
        if (!blocked) {
            this.position.copy(nextPos)
        } else {
            // Wall-slide via axis-separated movement
            const tryAxis = (dx, dz) => {
                const test = this.position.clone()
                test.x += dx
                test.z += dz
                const tBox = new THREE.Box3(
                    new THREE.Vector3(test.x - this.radius, nextPos.y - this.height + FOOT_LIFT, test.z - this.radius),
                    new THREE.Vector3(test.x + this.radius, nextPos.y + 0.1, test.z + this.radius)
                )
                for (const { box } of this.engine.getCollisionEntriesNear(test)) {
                    if (box.max.y <= nextPos.y - this.height + 0.05) continue
                    if (box.min.y >= nextPos.y + 0.05) continue
                    if (tBox.intersectsBox(box)) return false
                }
                this.position.x = test.x
                this.position.z = test.z
                return true
            }
            const xOk = tryAxis(delta.x, 0)
            const zOk = tryAxis(0, delta.z)
            if (!xOk && !zOk) {
                this.wallContact = true
                // Kill the velocity component pushing into the wall so we don't keep accelerating
                this.velocity.x *= 0.1
                this.velocity.z *= 0.1
            } else {
                // Partial block — still touching a surface
                this.wallContact = !(xOk && zOk)
            }
            this.position.y = nextPos.y
        }

        this.position.x = Math.max(-50, Math.min(50, this.position.x))
        this.position.z = Math.max(-50, Math.min(50, this.position.z))
    }

    _groundCheck() {
        if (this.position.y < -5) {
            const map = this.engine.mapData
            const fallback = this.role === 'hunter'
                ? (map?.spawnHunter ?? new THREE.Vector3(0, 1.7, 0))
                : (map?.spawnPrey   ?? new THREE.Vector3(0, 1.7, 21))
            this.position.copy(fallback)
            this.position.y = 1.7
            this.velocity.set(0, 0, 0)
            this.isOnGround = true
            this.spawnSettleTimer = 0.3
            console.log('[Player] Fell out of map — teleported to spawn')
            return
        }

        if (this.velocity.y > 0.05) {
            this.isOnGround = false
            return
        }

        const rayOrigin = this.position.clone()
        rayOrigin.y += 0.3
        this._groundRaycaster.set(rayOrigin, this._downVector)
        this._groundRaycaster.near = 0
        this._groundRaycaster.far = this.height + 0.6
        this._groundMeshes.length = 0
        for (const { mesh } of this.engine.getCollisionEntriesNear(this.position)) {
            if (mesh) this._groundMeshes.push(mesh)
        }
        const hits = this._groundRaycaster.intersectObjects(this._groundMeshes, false)
        if (hits.length > 0) {
            const groundY = hits[0].point.y
            const desiredY = groundY + this.height
            if (this.position.y < desiredY) {
                this.position.y = desiredY
                this.velocity.y = 0
                this.isOnGround = true
            } else if (this.position.y - desiredY < 0.15) {
                this.position.y = desiredY
                this.velocity.y = 0
                this.isOnGround = true
            } else {
                this.isOnGround = false
            }
        } else {
            if (this.position.y <= this.height) {
                this.position.y = this.height
                this.velocity.y = 0
                this.isOnGround = true
            } else {
                this.isOnGround = false
            }
        }
    }

    getLookDirection() {
        const dir = new THREE.Vector3()
        this.camera.getWorldDirection(dir)
        return dir
    }

    updatePeer(data) {
        if (!this.peerMesh) return
        this.peerIsPhasing = !!data.isPhasing
        this.peerIsHiding  = !!data.isHiding

        // Hide peer entirely while they hide in a locker
        this.peerMesh.visible = !this.peerIsHiding
        this.peerPosition.set(data.x, data.y, data.z)
        this.peerMesh.position.copy(this.peerPosition)

        // Phase translucency — traverse all children since peerMesh is a Group
        const op = this.peerIsPhasing ? 0.3 : 1.0
        this.peerMesh.traverse((child) => {
            if (child.material) {
                child.material.opacity = op
                child.material.transparent = op < 1
            }
        })

        if (data.ry !== undefined) this.peerMesh.rotation.y = data.ry
        if (this.peerHead && data.rx !== undefined) {
            this.peerHead.rotation.x = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, data.rx))
        }
    }

    getPeerDistance() {
        return this.position.distanceTo(this.peerPosition)
    }

    serialize() {
        return {
            x: this.position.x, y: this.position.y, z: this.position.z,
            ry: this.euler.y, rx: this.euler.x,
            isPhasing: this.isPhasing,
            isHiding:  this.isHiding,
        }
    }

    isMoving() {
        return !this.isHiding && (this.keys.w || this.keys.a || this.keys.s || this.keys.d)
    }

    getStamina()        { return this.stamina }
    getPhaseCooldown()  { return this.phaseCooldown }
    getHP()             { return this.hp }
    getMaxHP()          { return this.maxHp }

    takeDamage(amount = 1) {
        this.hp = Math.max(0, this.hp - amount)
        this.triggerShake(0.12)
        return this.hp <= 0  // returns true if dead
    }

    heal(amount = 1) {
        this.hp = Math.min(this.maxHp, this.hp + amount)
    }
}
