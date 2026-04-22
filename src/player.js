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

        // Camera shake
        this.shakeAmount    = 0
        this.shakeDecay     = 5

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
        const bodyGeo = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8)
        const bodyMat = new THREE.MeshStandardMaterial({
            color: '#888888', roughness: 0.8, transparent: true, opacity: 1.0
        })
        this.peerMesh = new THREE.Mesh(bodyGeo, bodyMat)
        this.peerMesh.castShadow = true
        this.peerMesh.visible = false

        const headGeo = new THREE.BoxGeometry(0.45, 0.42, 0.45)
        const headMat = new THREE.MeshStandardMaterial({ color: '#aaaaaa', roughness: 0.6, transparent: true })
        this.peerHead = new THREE.Mesh(headGeo, headMat)
        this.peerHead.position.set(0, 0.85, 0)
        this.peerMesh.add(this.peerHead)

        const noseGeo = new THREE.ConeGeometry(0.08, 0.22, 6)
        const noseMat = new THREE.MeshBasicMaterial({ color: '#00ffcc', transparent: true })
        this.peerNose = new THREE.Mesh(noseGeo, noseMat)
        this.peerNose.rotation.x = Math.PI / 2
        this.peerNose.position.set(0, 0.85, -0.28)
        this.peerMesh.add(this.peerNose)

        this.engine.scene.add(this.peerMesh)
    }

    setRole(role, spawnPos = null) {
        this.role = role
        const peerIsPrey = role === 'hunter'
        if (this.peerMesh) {
            this.peerMesh.material.color.set(peerIsPrey ? '#1133cc' : '#cc2200')
            this.peerMesh.material.emissive.set(peerIsPrey ? '#000833' : '#330000')
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
        for (const { box } of this.engine.collisionMeshes) {
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

        // Movement direction from camera facing
        const dir = new THREE.Vector3()
        const camForward = new THREE.Vector3()
        const camRight   = new THREE.Vector3()
        this.camera.getWorldDirection(camForward)
        camForward.y = 0
        camForward.normalize()
        camRight.crossVectors(camForward, new THREE.Vector3(0, 1, 0)).normalize()

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
        const inputForce = dir.clone().multiplyScalar(accelMag)
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
        const delta = this.velocity.clone().multiplyScalar(dt)
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
        const playerBox = new THREE.Box3(
            new THREE.Vector3(nextPos.x - this.radius, nextPos.y - this.height + FOOT_LIFT, nextPos.z - this.radius),
            new THREE.Vector3(nextPos.x + this.radius, nextPos.y + 0.1, nextPos.z + this.radius)
        )

        let blocked = false
        for (const { box } of this.engine.collisionMeshes) {
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
                for (const { box } of this.engine.collisionMeshes) {
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

        const rayOrigin = this.position.clone()
        rayOrigin.y += 0.3
        const ray = new THREE.Raycaster(rayOrigin, new THREE.Vector3(0, -1, 0), 0, this.height + 0.6)
        const hits = ray.intersectObjects(this.engine.collisionMeshes.map(c => c.mesh), false)
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

        // Phase translucency
        const op = this.peerIsPhasing ? 0.3 : 1.0
        if (this.peerMesh.material)        this.peerMesh.material.opacity = op
        if (this.peerHead?.material)       this.peerHead.material.opacity = op
        if (this.peerNose?.material)       this.peerNose.material.opacity = op

        if (data.ry !== undefined) this.peerMesh.rotation.y = data.ry
        if (this.peerHead && data.rx !== undefined) {
            this.peerHead.rotation.x = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, data.rx))
            if (this.peerNose) this.peerNose.rotation.x = Math.PI / 2 + this.peerHead.rotation.x * 0.5
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
}
