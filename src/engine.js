// src/engine.js — Three.js Scene Engine (flashlight toggle, BPM-driven beam, occlusion culling, lockers, extraction emergency)
import * as THREE from 'three'
import { generateMap } from './map.js'
import { VolumetricFlashlight } from './volumetricFlashlight.js'

const FLASHLIGHT_BASE_INTENSITY = 40             // bright enough to fill the cone at 0.85 exposure
const FLASHLIGHT_BASE_ANGLE     = Math.PI / 7   // ~25.7 deg
const FLASHLIGHT_BASE_DISTANCE  = 40
const HUNTER_BASE_EXPOSURE      = 0.85           // dark world; flashlight punches through
const TUNNEL_BPM_THRESHOLD      = 100
const TUNNEL_BPM_FULL           = 160

export class Engine {
    constructor() {
        this.scene           = new THREE.Scene()
        this.collisionMeshes = []
        this.doors           = []      // { mesh, collider, position, isOpen, rooms }
        this.ventZones       = []
        this.renderer        = null
        this.camera          = null
        this.volumetric      = null   // VolumetricFlashlight (owns SpotLight + visible cone)
        this.flashlightOn    = false   // toggled per-role in setRole()
        this._forcedFlashlightTimer   = 0
        this._forcedFlashlightRestore = false
        this.ambientLight    = null
        this.hemisphereLight = null
        this.moonLight       = null
        this.role            = null
        this.ghostLights     = []
        this.dustPoints      = null
        this.clock           = new THREE.Clock()
        this.onLoadComplete  = null
        this._flickerTimer   = 0
        this._raycaster      = new THREE.Raycaster()
        this._dustPhase      = 0
        this._lightFlickerTimer = 0
        this._ghostUpdateTimer = 0
        this.mapData         = null
        this._extractionPulse = 0

        // Dynamic resolution scaling
        this._fpsFrames  = 0
        this._fpsTimer   = 0
        this._currentFPS = 60
        this._lowspec    = new URLSearchParams(window.location.search).get('lowspec') === '1'
        // lowspec: start at minimum tier; normal: start at mid tier, scale up if FPS allows
        this._pixelTier   = this._lowspec ? 0 : 1
        this._pixelRatios = this._lowspec ? [0.35, 0.45, 0.55] : [0.5, 0.7, 0.85]

        // Occlusion culling
        this.rooms             = []   // [{name, x, z, w, h}]
        this.roomConnections   = new Map()  // roomName -> [{neighbor, door}]
        this._lastVisibleRoom  = null
        this._occlusionDirty   = true
        this._occlusionInitialized = false
        this._visibleRooms     = new Set()
        this._roomObjects      = new Map()    // roomName -> Object3D[]
        this._allRoomObjects   = new Set()
        this.cachedCollisionMeshes = []
        this._collisionCacheDirty  = true
        this._collisionEntriesByRoom = new Map()
        this._globalCollisionEntries = []
        this._doorStateVersion = 0
        this._collisionNearCacheRoom = null
        this._collisionNearCacheVersion = -1
        this._collisionNearCacheEntries = []

        // Lockers
        this.lockers = []

        // Health pickups
        this.healthPickups = []

        // Cheap contact shadows
        this._localBlobShadow = null
        this._peerBlobShadow  = null

        // Extraction emergency
        this._emergencyActive = false
        this._emergencyLight  = null
        this._emergencyTimer  = 0
    }

    init(canvas, assetManager = null) {
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
        this.renderer.setSize(window.innerWidth, window.innerHeight)
        this._applyPixelTier()
        this.renderer.shadowMap.enabled = false
        this.renderer.setClearColor('#050505')
        this.renderer.toneMapping         = THREE.ACESFilmicToneMapping
        this.renderer.toneMappingExposure = 1.8

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200)
        this.camera.position.set(0, 1.7, 0)
        this.scene.add(this.camera)

        // lowspec: cheaper linear fog; normal: exponential for atmospheric depth
        this.scene.fog = this._lowspec
            ? new THREE.Fog('#050505', 18, 65)
            : new THREE.FogExp2('#050505', 0.025)

        this.ambientLight = new THREE.AmbientLight('#b9d5ff', 0.6)
        this.scene.add(this.ambientLight)

        this.hemisphereLight = new THREE.HemisphereLight('#2244aa', '#3d1500', 0.8)
        this.scene.add(this.hemisphereLight)

        this.moonLight = new THREE.DirectionalLight('#cce0ff', 0.5)
        this.moonLight.position.set(5, 12, -5)
        this.moonLight.castShadow = false
        this.scene.add(this.moonLight)

        this.volumetric = new VolumetricFlashlight(this.scene, this.camera)

        if (!this._lowspec) {
            const ghostColors = ['#00ffcc', '#ff6600']
            ghostColors.forEach((color) => {
                const g = new THREE.PointLight(color, 0.4, 10)
                g.userData.baseIntensity = 0.4
                this.scene.add(g)
                this.ghostLights.push({ light: g, offset: Math.random() * Math.PI * 2 })
            })
        }

        this._addDustMotes()

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight
            this.camera.updateProjectionMatrix()
            this.renderer.setSize(window.innerWidth, window.innerHeight)
            this._applyPixelTier()
        })

        // ── GENERATE MAP (pass assetManager so GLB props are placed) ──
        this.mapData         = generateMap(this.scene, this.renderer, assetManager)
        this.collisionMeshes = this.mapData.collisionMeshes
        this.doors           = this.mapData.doors      ?? []
        this.ventZones       = this.mapData.ventZones  ?? []
        this.lockers         = this.mapData.lockers    ?? []
        this.healthPickups   = this.mapData.healthPickups ?? []
        this.rooms           = this.mapData.rooms      ?? []
        this._roomObjects    = this.mapData.roomObjects ?? new Map()
        this._allRoomObjects = this.mapData.allRoomObjects ?? new Set()

        // Cache meshes for raycasting
        this._rebuildCollisionCache()

        // Build room connections from each door's `rooms` pair
        for (const room of this.rooms) this.roomConnections.set(room.name, [])
        for (const door of this.doors) {
            if (!door.rooms || door.rooms.length !== 2) continue
            const [a, b] = door.rooms
            this.roomConnections.get(a)?.push({ neighbor: b, door })
            this.roomConnections.get(b)?.push({ neighbor: a, door })
        }

        // Emergency light over the extraction zone (off until activated)
        const ec = this.mapData.extractionCenter ?? new THREE.Vector3(0, 0, 0)
        this._emergencyLight = new THREE.PointLight('#ff2200', 0, 14, 1.6)
        this._emergencyLight.position.set(ec.x, 3.6, ec.z)
        this.scene.add(this._emergencyLight)

        console.log(
            `[Engine] Map ready — ${this.collisionMeshes.length} colliders | ` +
            `${this.doors.length} doors | ${this.lockers.length} lockers | ` +
            `${this.rooms.length} rooms | ${this._allRoomObjects.size} tagged objects` +
            (this._lowspec ? ' | LOWSPEC MODE' : '')
        )

        setTimeout(() => { if (this.onLoadComplete) this.onLoadComplete() }, 50)
    }

    _addDustMotes() {
        if (this._lowspec) return   // skip particle shader on low-end devices
        const COUNT     = 150
        const positions = new Float32Array(COUNT * 3)
        for (let i = 0; i < COUNT; i++) {
            positions[i * 3]     = (Math.random() - 0.5) * 60
            positions[i * 3 + 1] = 0.2 + Math.random() * 3.5
            positions[i * 3 + 2] = (Math.random() - 0.5) * 60
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: new THREE.Color('#ffe8c0') },
            },
            vertexShader: `
                uniform float uTime;
                varying float vAlpha;
                void main() {
                    vec3 p = position;
                    p.y += sin(uTime * 0.5 + position.x * 1.7 + position.z * 2.1) * 0.08;
                    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
                    gl_PointSize = clamp(60.0 / -mvPosition.z, 1.0, 3.0);
                    gl_Position = projectionMatrix * mvPosition;
                    vAlpha = 0.35 + 0.2 * sin(uTime + position.x * 0.3);
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;
                void main() {
                    float dist = length(gl_PointCoord - vec2(0.5));
                    if (dist > 0.5) discard;
                    float alpha = (1.0 - smoothstep(0.15, 0.5, dist)) * vAlpha;
                    gl_FragColor = vec4(uColor, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
        })
        this.dustPoints = new THREE.Points(geo, mat)
        this.dustPoints.frustumCulled = false
        this.scene.add(this.dustPoints)
    }

    // ─────────────────────────────────────────────────────────────
    // FLASHLIGHT
    // ─────────────────────────────────────────────────────────────
    get flashlight() { return this.volumetric?.light ?? null }

    toggleFlashlight() {
        if (this._forcedFlashlightTimer > 0) {
            this.setFlashlightVisible(false)
            return false
        }
        this.flashlightOn = !this.flashlightOn
        this.setFlashlightVisible(this.flashlightOn)
        return this.flashlightOn
    }

    setFlashlightVisible(visible) {
        if (visible && this._forcedFlashlightTimer > 0) visible = false
        this.flashlightOn = visible
        if (this.volumetric) this.volumetric.toggle(visible)
    }

    forceFlashlightOff(duration = 2.0) {
        this._forcedFlashlightRestore = this.flashlightOn
        this._forcedFlashlightTimer = Math.max(this._forcedFlashlightTimer, duration)
        this.setFlashlightVisible(false)
    }

    _updateForcedFlashlight(dt) {
        if (this._forcedFlashlightTimer <= 0) return
        this._forcedFlashlightTimer = Math.max(0, this._forcedFlashlightTimer - dt)
        if (this._forcedFlashlightTimer === 0) {
            const shouldRestore = this._forcedFlashlightRestore
            this._forcedFlashlightRestore = false
            if (shouldRestore) this.setFlashlightVisible(true)
        }
    }

    _createBlobShadow(radius = 0.42, opacity = 0.34) {
        const geo = new THREE.CircleGeometry(radius, 24)
        const mat = new THREE.MeshBasicMaterial({
            color: '#000000',
            transparent: true,
            opacity,
            depthWrite: false,
        })
        const mesh = new THREE.Mesh(geo, mat)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.y = 0.012
        mesh.renderOrder = -5
        mesh.frustumCulled = false
        mesh.userData.nonColliding = true
        this.scene.add(mesh)
        return mesh
    }

    updateBlobShadows(player) {
        if (!player) return
        if (!this._localBlobShadow) this._localBlobShadow = this._createBlobShadow(player.role === 'prey' ? 0.32 : 0.48, 0.28)
        this._localBlobShadow.position.set(player.position.x, 0.012, player.position.z)
        this._localBlobShadow.visible = !player.isHiding

        if (!this._peerBlobShadow) this._peerBlobShadow = this._createBlobShadow(player.peerRole === 'prey' ? 0.30 : 0.46, 0.30)
        this._peerBlobShadow.position.set(player.peerPosition.x, 0.012, player.peerPosition.z)
        this._peerBlobShadow.visible = !!player.peerMesh?.visible && !player.peerIsHiding
    }

    /** Apply BPM/Fear distortion to the spotlight. Called from update(). */
    _updateFlashlight(fearLevel, bpm, dt) {
        if (!this.volumetric) return

        // Keep the shader uniforms (time, cone transform, fear-flicker) in sync every frame.
        this.volumetric.update(dt, fearLevel)

        const light = this.volumetric.light
        const fill  = this.volumetric.fill

        if (!this.flashlightOn) {
            light.intensity = 0
            fill.intensity  = 0
            return
        }

        // Tunnel-vision factor — 0 below threshold, 1 at full panic.
        const tunnel = Math.min(1, Math.max(0, (bpm - TUNNEL_BPM_THRESHOLD) / (TUNNEL_BPM_FULL - TUNNEL_BPM_THRESHOLD)))

        light.angle    = FLASHLIGHT_BASE_ANGLE * (1 - tunnel * 0.5)
        light.distance = FLASHLIGHT_BASE_DISTANCE - fearLevel * 6

        const baseInt = FLASHLIGHT_BASE_INTENSITY * (1 - tunnel * 0.4)
        const flicker = this.volumetric.getCurrentFlicker()
        light.intensity = baseInt * flicker
        fill.intensity  = baseInt * flicker * 0.25

        // Beam shake when BPM > 100.
        if (bpm > TUNNEL_BPM_THRESHOLD) {
            const sh = Math.min(0.07, (bpm - TUNNEL_BPM_THRESHOLD) / 700)
            light.target.position.x = (Math.random() - 0.5) * sh
            light.target.position.y = (Math.random() - 0.5) * sh
            light.target.position.z = -10
        } else {
            light.target.position.set(0, 0, -10)
        }
    }

    // ─────────────────────────────────────────────────────────────
    // FRAME UPDATE
    // ─────────────────────────────────────────────────────────────
    update(elapsed, fearLevel = 0, dt = 0.016, bpm = 75) {
        this._trackFPS(dt)
        this._updateForcedFlashlight(dt)

        // Ghost lights — update every 3rd frame to save CPU/GPU uniform uploads.
        this._ghostUpdateTimer += dt
        if (this._ghostUpdateTimer >= 0.2) {
            this._ghostUpdateTimer = 0
            this.ghostLights.forEach(({ light, offset }, i) => {
                const angle  = elapsed * (0.1 + i * 0.06) + offset
                const radius = 8 + Math.sin(elapsed * 0.25 + i) * 3
                light.position.set(
                    Math.cos(angle) * radius,
                    2 + Math.sin(elapsed * 1.8 + i),
                    Math.sin(angle) * radius
                )
            })
        }

        this._updateFlashlight(fearLevel, bpm, dt)

        // Room lights flicker at a fixed low rate; invisible rooms do not pay update cost.
        this._lightFlickerTimer += dt
        if (this.mapData?.roomLights && this._lightFlickerTimer >= 0.10) {
            this._lightFlickerTimer = 0
            for (const { light } of this.mapData.roomLights) {
                if (!light.visible) continue
                const fs    = light.userData.flickerStrength ?? 0.5
                const baseI = light.userData.baseIntensity ?? 5
                const mult  = light.userData.flickerMultiplier ?? 1.0
                const decay = Math.random() > 0.98 ? 0.2 : 1.0
                light.intensity = baseI * mult * decay * (1 - fs + Math.random() * fs)
            }
        }

        // Health pickup bob — consolidated logic
        for (const hp of this.healthPickups) {
            if (hp.collected) continue
            hp.mesh.position.y = 0.6 + Math.sin(elapsed * 2.5 + (hp.phaseOffset ?? 0)) * 0.12
            hp.mesh.rotation.y += dt * 1.5
        }

        // Dust drift runs on the GPU; the CPU only advances one uniform.
        if (this.dustPoints) {
            this._dustPhase += dt
            this.dustPoints.rotation.y += dt * 0.004
            this.dustPoints.material.uniforms.uTime.value = this._dustPhase
        }

        // Fear desaturation (role-relative)
        const baseExposure = this.role === 'prey' ? 2.6 : HUNTER_BASE_EXPOSURE
        this.renderer.toneMappingExposure = fearLevel > 0.8
            ? Math.max(baseExposure * 0.45, baseExposure - (fearLevel - 0.8) * 3.5)
            : baseExposure

        // Emergency light pulse
        if (this._emergencyActive && this._emergencyLight) {
            this._emergencyTimer += dt
            const pulse = 4 + Math.sin(this._emergencyTimer * 12) * 2.5
            const flick = Math.random() < 0.08 ? 0 : 1
            this._emergencyLight.intensity = pulse * flick
        }
    }

    // ─────────────────────────────────────────────────────────────
    // ROLE — asymmetric vision (prey bright, hunter dark + flashlight)
    // ─────────────────────────────────────────────────────────────
    _trackFPS(dt) {
        this._fpsFrames++
        this._fpsTimer += dt
        if (this._fpsTimer < 1.0) return
        this._currentFPS = this._fpsFrames / this._fpsTimer
        this._fpsFrames = 0
        this._fpsTimer = 0
        this._adaptPixelRatio()
    }

    _adaptPixelRatio() {
        const fps = this._currentFPS
        let targetTier = this._pixelTier
        if (fps < 40 && this._pixelTier > 0) targetTier = 0
        else if (fps < 50 && this._pixelTier > 1) targetTier = 1
        else if (fps > 58 && this._pixelTier < 2) targetTier = 2
        if (targetTier === this._pixelTier) return
        this._pixelTier = targetTier
        this._applyPixelTier()
    }

    _applyPixelTier() {
        if (!this.renderer) return
        const deviceRatio = window.devicePixelRatio || 1
        this.renderer.setPixelRatio(Math.min(deviceRatio, this._pixelRatios[this._pixelTier]))
    }

    setRole(role) {
        this.role = role
        if (role === 'prey') {
            if (this.scene.fog?.density !== undefined) this.scene.fog.density = 0.013
            if (this.ambientLight)     this.ambientLight.intensity = 1.2
            if (this.hemisphereLight)  this.hemisphereLight.intensity = 1.4
            if (this.moonLight)        this.moonLight.intensity = 0.5
            for (const { light } of this.ghostLights) light.intensity = light.userData.baseIntensity ?? 0.4
            this.renderer.toneMappingExposure = 2.6
            if (this.mapData?.roomLights) {
                for (const { light } of this.mapData.roomLights) {
                    if (light.userData) light.userData.flickerMultiplier = 1.2
                }
            }
            this.setFlashlightVisible(false)   // Prey starts WITHOUT flashlight
        } else {
            // Hunter — world is dark; only the flashlight cone reveals geometry.
            // Fog at 0.055 keeps distant rooms black without cutting off the 40-unit beam.
            // A hair of ambient (0.04) lets the hunter barely read surfaces right in front.
            if (this.scene.fog?.density !== undefined) this.scene.fog.density = 0.055
            if (this.ambientLight)     this.ambientLight.intensity = 0.04
            if (this.hemisphereLight)  this.hemisphereLight.intensity = 0.0
            if (this.moonLight)        this.moonLight.intensity = 0.0
            for (const { light } of this.ghostLights) light.intensity = 0.008
            this.renderer.toneMappingExposure = HUNTER_BASE_EXPOSURE
            if (this.mapData?.roomLights) {
                for (const { light } of this.mapData.roomLights) {
                    if (light.userData) light.userData.flickerMultiplier = 0.015
                }
            }
            this.setFlashlightVisible(true)    // Hunter starts WITH flashlight
        }
    }

    render(scene, camera) {
        const scn = scene ?? this.scene
        const cam = camera ?? this.camera

        // Pass 1: scene → canvas (depth buffer stays on the default framebuffer).
        this.renderer.setRenderTarget(null)
        this.renderer.render(scn, cam)

        // Pass 2: volumetric cone composited on top (additive, no depth write).
        // Skip in lowspec — SpotLight still illuminates, just no visible cone mesh.
        if (!this._lowspec && this.volumetric?.isOn()) {
            const prev = this.renderer.autoClear
            this.renderer.autoClear = false
            this.renderer.render(this.volumetric.fxScene, cam)
            this.renderer.autoClear = prev
        }
    }

    _rebuildCollisionCache() {
        this.cachedCollisionMeshes.length = 0
        this._collisionEntriesByRoom = new Map()
        this._globalCollisionEntries = []
        for (const room of this.rooms) this._collisionEntriesByRoom.set(room.name, [])
        for (const { mesh } of this.collisionMeshes) {
            if (mesh) this.cachedCollisionMeshes.push(mesh)
        }
        for (const entry of this.collisionMeshes) {
            const rooms = entry.mesh?.userData?.rooms ?? null
            if (!rooms || rooms.length === 0) {
                this._globalCollisionEntries.push(entry)
                continue
            }
            for (const roomName of rooms) {
                this._collisionEntriesByRoom.get(roomName)?.push(entry)
            }
        }
        this._collisionCacheDirty = false
        this._collisionNearCacheRoom = null
        this._collisionNearCacheVersion = -1
        this._collisionNearCacheEntries = []
    }

    markCollisionCacheDirty() {
        this._collisionCacheDirty = true
        this._collisionNearCacheRoom = null
        this._collisionNearCacheVersion = -1
    }

    getCollisionMeshList() {
        if (this._collisionCacheDirty) this._rebuildCollisionCache()
        return this.cachedCollisionMeshes
    }

    getCollisionEntriesNear(pos) {
        if (this._collisionCacheDirty) this._rebuildCollisionCache()
        const roomName = this.findRoomContaining(pos)
        if (!roomName) return this.collisionMeshes

        if (
            this._collisionNearCacheRoom === roomName &&
            this._collisionNearCacheVersion === this._doorStateVersion
        ) {
            return this._collisionNearCacheEntries
        }

        const rooms = new Set([roomName])
        const conns = this.roomConnections.get(roomName) ?? []
        for (const conn of conns) {
            if (conn.door.isOpen) rooms.add(conn.neighbor)
        }

        const entries = [...this._globalCollisionEntries]
        const seen = new Set(entries)
        for (const rn of rooms) {
            const list = this._collisionEntriesByRoom.get(rn) ?? []
            for (const entry of list) {
                if (seen.has(entry)) continue
                entries.push(entry)
                seen.add(entry)
            }
        }
        this._collisionNearCacheRoom = roomName
        this._collisionNearCacheVersion = this._doorStateVersion
        this._collisionNearCacheEntries = entries
        return entries
    }

    getCollisionMeshListNear(pos) {
        return this.getCollisionEntriesNear(pos).map(entry => entry.mesh)
    }

    raycastCollision(ray) {
        this._raycaster.set(ray.origin, ray.direction)
        this._raycaster.near = 0
        this._raycaster.far  = 50
        const hits = this._raycaster.intersectObjects(this.getCollisionMeshList(), true)
        return hits.length > 0 ? hits[0] : null
    }

    // ─────────────────────────────────────────────────────────────
    // INTERACTIVE DOORS
    // ─────────────────────────────────────────────────────────────
    _applyDoorState(door, isOpen) {
        if (door.isOpen === isOpen) return false
        door.isOpen = isOpen
        if (isOpen) {
            door.mesh.visible = false
            const idx = this.collisionMeshes.indexOf(door.collider)
            if (idx !== -1) this.collisionMeshes.splice(idx, 1)
        } else {
            door.mesh.visible = true
            if (!this.collisionMeshes.includes(door.collider)) {
                this.collisionMeshes.push(door.collider)
            }
        }
        this.markCollisionCacheDirty()
        this._doorStateVersion += 1
        this._occlusionDirty = true
        return true
    }

    tryInteractDoor(playerPos) {
        let nearest = null
        let nearestDist = Infinity
        for (const door of this.doors) {
            const d = playerPos.distanceTo(door.position)
            if (d < 2.5 && d < nearestDist) { nearest = door; nearestDist = d }
        }
        if (!nearest) return null

        this._applyDoorState(nearest, !nearest.isOpen)
        this.updateOcclusion(playerPos, this.findRoomContaining(playerPos))
        // Use world position as the network key — immune to any ordering differences.
        return { x: nearest.position.x, z: nearest.position.z, isOpen: nearest.isOpen }
    }

    // Apply a door state received from a remote peer. Immediately refreshes occlusion.
    applyRemoteDoor(x, z, isOpen) {
        const door = this.doors.find(
            d => Math.abs(d.position.x - x) < 0.5 && Math.abs(d.position.z - z) < 0.5
        )
        if (!door) return false
        const changed = this._applyDoorState(door, !!isOpen)
        if (changed) {
            // Force occlusion to run on the next game-loop iteration.
            this._occlusionDirty = true
        }
        return changed
    }

    // ─────────────────────────────────────────────────────────────
    // LOCKERS — find nearest within range
    // ─────────────────────────────────────────────────────────────
    findNearestLocker(playerPos, range = 1.6) {
        let nearest = null
        let bestDist = range
        for (const locker of this.lockers) {
            const d = playerPos.distanceTo(locker.position)
            if (d < bestDist) {
                nearest = locker
                bestDist = d
            }
        }
        return nearest
    }

    // ─────────────────────────────────────────────────────────────
    // OCCLUSION — only render current room + adjacent open-door rooms
    // ─────────────────────────────────────────────────────────────
    findRoomContaining(pos) {
        for (const r of this.rooms) {
            if (pos.x >= r.x - r.w / 2 && pos.x <= r.x + r.w / 2 &&
                pos.z >= r.z - r.h / 2 && pos.z <= r.z + r.h / 2) {
                return r.name
            }
        }
        return null
    }

    _isObjectInVisibleRoom(obj, visibleRooms) {
        const roomNames = obj.userData.rooms ?? []
        for (const roomName of roomNames) {
            if (visibleRooms.has(roomName)) return true
        }
        return false
    }

    _setRoomObjectVisibility(obj, visibleRooms) {
        const doorState = obj.userData.doorState
        const inVisibleRoom = this._isObjectInVisibleRoom(obj, visibleRooms)
        obj.visible = doorState ? (!doorState.isOpen && inVisibleRoom) : inVisibleRoom
    }

    _setAllRoomObjectsVisible(visible) {
        for (const obj of this._allRoomObjects) obj.visible = visible
    }

    updateOcclusion(playerPos, currentRoom = null) {
        if (!this.rooms.length) return
        const here = currentRoom ?? this.findRoomContaining(playerPos)
        if (!here) {
            if (this._lastVisibleRoom !== null) {
                this._lastVisibleRoom = null
                this._visibleRooms.clear()
                this._occlusionInitialized = false
                this._setAllRoomObjectsVisible(true)
            }
            return
        }
        if (!this._occlusionDirty && here === this._lastVisibleRoom) return
        this._lastVisibleRoom = here
        this._occlusionDirty  = false

        // Show current room + adjacent rooms through open doors
        const nextVisibleRooms = new Set([here])
        const conns   = this.roomConnections.get(here) ?? []
        for (const conn of conns) {
            if (conn.door.isOpen) nextVisibleRooms.add(conn.neighbor)
        }

        if (!this._occlusionInitialized) {
            for (const obj of this._allRoomObjects) {
                this._setRoomObjectVisibility(obj, nextVisibleRooms)
            }
            this._visibleRooms = nextVisibleRooms
            this._occlusionInitialized = true
            return
        }

        for (const roomName of this._visibleRooms) {
            if (nextVisibleRooms.has(roomName)) continue
            const list = this._roomObjects.get(roomName) ?? []
            for (const obj of list) {
                this._setRoomObjectVisibility(obj, nextVisibleRooms)
            }
        }

        for (const rName of nextVisibleRooms) {
            if (this._visibleRooms.has(rName)) continue
            const list = this._roomObjects.get(rName) ?? []
            for (const obj of list) this._setRoomObjectVisibility(obj, nextVisibleRooms)
        }

        for (const door of this.doors) {
            this._setRoomObjectVisibility(door.mesh, nextVisibleRooms)
        }

        this._visibleRooms = nextVisibleRooms
    }

    // ─────────────────────────────────────────────────────────────
    // EXTRACTION
    // ─────────────────────────────────────────────────────────────
    isInExtractionZone(playerPos) {
        if (!this.mapData) return false
        const ec = this.mapData.extractionCenter
        const dx = playerPos.x - ec.x
        const dz = playerPos.z - ec.z
        return Math.sqrt(dx * dx + dz * dz) < this.mapData.extractionRadius
    }

    getExtractionDirection(playerPos) {
        if (!this.mapData) return new THREE.Vector3(0, 0, -1)
        const ec = this.mapData.extractionCenter
        return new THREE.Vector3(ec.x - playerPos.x, 0, ec.z - playerPos.z).normalize()
    }

    activateExtractionEmergency() {
        this._emergencyActive = true
    }

    // ─────────────────────────────────────────────────────────────────
    // HEALTH PICKUPS
    // ─────────────────────────────────────────────────────────────────
    checkHealthPickup(playerPos, range = 1.8) {
        for (const hp of this.healthPickups) {
            if (hp.collected) continue
            const d = playerPos.distanceTo(hp.position)
            if (d < range) {
                hp.collected = true
                hp.mesh.visible = false
                return hp
            }
        }
        return null
    }
}
