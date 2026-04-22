// src/engine.js — Three.js Scene Engine (flashlight toggle, BPM-driven beam, occlusion culling, lockers, extraction emergency)
import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { generateMap } from './map.js'

const FLASHLIGHT_BASE_INTENSITY = 5
const FLASHLIGHT_BASE_ANGLE     = Math.PI / 9   // ~20°
const FLASHLIGHT_BASE_DISTANCE  = 18
const TUNNEL_BPM_THRESHOLD      = 100
const TUNNEL_BPM_FULL           = 160            // full tunnel-vision at this BPM

export class Engine {
    constructor() {
        this.scene           = new THREE.Scene()
        this.collisionMeshes = []
        this.doors           = []      // { mesh, collider, position, isOpen, rooms }
        this.ventZones       = []
        this.renderer        = null
        this.camera          = null
        this.flashlight      = null
        this.flashFill       = null
        this.flashlightOn    = false   // toggled per-role in setRole()
        this.ambientLight    = null
        this.hemisphereLight = null
        this.role            = null
        this.ghostLights     = []
        this.dustPoints      = null
        this.clock           = new THREE.Clock()
        this.onLoadComplete  = null
        this._flickerTimer   = 0
        this._raycaster      = new THREE.Raycaster()
        this._dustPhase      = 0
        this.mapData         = null
        this._extractionPulse = 0

        // Occlusion culling
        this.rooms             = []   // [{name, x, z, w, h}]
        this.roomConnections   = new Map()  // roomName -> [{neighbor, door}]
        this._lastVisibleRoom  = null
        this._occlusionDirty   = true
        this._roomTagged       = []   // every Object3D that has userData.rooms

        // Lockers
        this.lockers = []

        // Extraction emergency
        this._emergencyActive = false
        this._emergencyLight  = null
        this._emergencyTimer  = 0
    }

    init(canvas) {
        RectAreaLightUniformsLib.init()

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
        this.renderer.setSize(window.innerWidth, window.innerHeight)
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        this.renderer.shadowMap.enabled = true
        this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap
        this.renderer.setClearColor('#050505')
        this.renderer.toneMapping         = THREE.ACESFilmicToneMapping
        this.renderer.toneMappingExposure = 1.8

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200)
        this.camera.position.set(0, 1.7, 0)
        this.scene.add(this.camera)

        this.scene.fog = new THREE.FogExp2('#050505', 0.025)

        this.ambientLight = new THREE.AmbientLight('#b9d5ff', 0.6)
        this.scene.add(this.ambientLight)

        this.hemisphereLight = new THREE.HemisphereLight('#2244aa', '#3d1500', 0.8)
        this.scene.add(this.hemisphereLight)

        const moon = new THREE.DirectionalLight('#cce0ff', 0.5)
        moon.position.set(5, 12, -5)
        moon.castShadow = true
        moon.shadow.mapSize.set(512, 512)
        moon.shadow.camera.far    = 60
        moon.shadow.camera.left   = -40
        moon.shadow.camera.right  = 40
        moon.shadow.camera.top    = 40
        moon.shadow.camera.bottom = -40
        this.scene.add(moon)

        this.flashlight = new THREE.SpotLight('#fff5e0', FLASHLIGHT_BASE_INTENSITY, FLASHLIGHT_BASE_DISTANCE, FLASHLIGHT_BASE_ANGLE, 0.3, 1.8)
        this.flashlight.castShadow = true
        this.flashlight.shadow.mapSize.set(512, 512)
        this.flashlight.shadow.camera.far = FLASHLIGHT_BASE_DISTANCE
        this.camera.add(this.flashlight)
        this.camera.add(this.flashlight.target)
        this.flashlight.target.position.set(0, 0, -1)

        this.flashFill = new THREE.PointLight('#fff5e0', 2, 5)
        this.camera.add(this.flashFill)

        const ghostColors = ['#ff00cc', '#00ffcc', '#ff6600']
        ghostColors.forEach((color) => {
            const g = new THREE.PointLight(color, 0.4, 10)
            this.scene.add(g)
            this.ghostLights.push({ light: g, offset: Math.random() * Math.PI * 2 })
        })

        this._addDustMotes()

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight
            this.camera.updateProjectionMatrix()
            this.renderer.setSize(window.innerWidth, window.innerHeight)
        })

        // ── GENERATE MAP ──
        this.mapData         = generateMap(this.scene, this.renderer)
        this.collisionMeshes = this.mapData.collisionMeshes
        this.doors           = this.mapData.doors      ?? []
        this.ventZones       = this.mapData.ventZones  ?? []
        this.lockers         = this.mapData.lockers    ?? []
        this.rooms           = this.mapData.rooms      ?? []
        this._roomTagged     = this.mapData.roomTagged ?? []

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
            `${this.rooms.length} rooms | ${this._roomTagged.length} tagged objects`
        )

        setTimeout(() => { if (this.onLoadComplete) this.onLoadComplete() }, 50)
    }

    _addDustMotes() {
        const COUNT     = 1500
        const positions = new Float32Array(COUNT * 3)
        for (let i = 0; i < COUNT; i++) {
            positions[i * 3]     = (Math.random() - 0.5) * 60
            positions[i * 3 + 1] = 0.2 + Math.random() * 3.5
            positions[i * 3 + 2] = (Math.random() - 0.5) * 60
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const mat = new THREE.PointsMaterial({
            color: '#ffe8c0', size: 0.02, sizeAttenuation: true,
            transparent: true, opacity: 0.5, depthWrite: false,
        })
        this.dustPoints = new THREE.Points(geo, mat)
        this.scene.add(this.dustPoints)
    }

    // ─────────────────────────────────────────────────────────────
    // FLASHLIGHT
    // ─────────────────────────────────────────────────────────────
    toggleFlashlight() {
        this.flashlightOn = !this.flashlightOn
        this.setFlashlightVisible(this.flashlightOn)
        return this.flashlightOn
    }

    setFlashlightVisible(visible) {
        this.flashlightOn = visible
        if (this.flashlight) this.flashlight.visible = visible
        if (this.flashFill)  this.flashFill.visible  = visible
    }

    /** Apply BPM/Fear distortion to the spotlight. Called from update(). */
    _updateFlashlight(fearLevel, bpm, dt) {
        if (!this.flashlight) return
        if (!this.flashlightOn) {
            this.flashlight.intensity = 0
            if (this.flashFill) this.flashFill.intensity = 0
            return
        }

        // Tunnel-vision factor — 0 below threshold, 1 at full panic
        const tunnel = Math.min(1, Math.max(0, (bpm - TUNNEL_BPM_THRESHOLD) / (TUNNEL_BPM_FULL - TUNNEL_BPM_THRESHOLD)))

        // Narrow beam + dim intensity (down to 60% at full tunnel)
        this.flashlight.angle = FLASHLIGHT_BASE_ANGLE * (1 - tunnel * 0.5)
        const baseInt = FLASHLIGHT_BASE_INTENSITY * (1 - tunnel * 0.4)

        // Fear > 0.8 → uncontrollable flicker. Fear > 0.6 → softer flicker.
        if (fearLevel > 0.8) {
            const inst = Math.random() < 0.22 ? 0 : baseInt * (0.4 + Math.random() * 0.7)
            this.flashlight.intensity = inst
            if (this.flashFill) this.flashFill.intensity = inst * 0.35
        } else if (fearLevel > 0.6) {
            this._flickerTimer += dt
            if (this._flickerTimer > 0.04 + Math.random() * 0.09) {
                this._flickerTimer = 0
                const inst = Math.random() < 0.15 ? 0 : baseInt * (0.6 + Math.random() * 0.8)
                this.flashlight.intensity = inst
                if (this.flashFill) this.flashFill.intensity = inst * 0.4
            }
        } else {
            this.flashlight.intensity = baseInt
            if (this.flashFill) this.flashFill.intensity = baseInt * 0.4
        }

        // Beam range shortens with fear
        this.flashlight.distance = FLASHLIGHT_BASE_DISTANCE - fearLevel * 6

        // Beam shake when BPM > 100
        if (bpm > TUNNEL_BPM_THRESHOLD) {
            const sh = Math.min(0.07, (bpm - TUNNEL_BPM_THRESHOLD) / 700)
            this.flashlight.target.position.x = (Math.random() - 0.5) * sh
            this.flashlight.target.position.y = (Math.random() - 0.5) * sh
            this.flashlight.target.position.z = -1
        } else {
            this.flashlight.target.position.set(0, 0, -1)
        }
    }

    // ─────────────────────────────────────────────────────────────
    // FRAME UPDATE
    // ─────────────────────────────────────────────────────────────
    update(elapsed, fearLevel = 0, dt = 0.016, bpm = 75) {
        // Ghost lights
        this.ghostLights.forEach(({ light, offset }, i) => {
            const angle  = elapsed * (0.1 + i * 0.06) + offset
            const radius = 8 + Math.sin(elapsed * 0.25 + i) * 3
            light.position.set(
                Math.cos(angle) * radius,
                2 + Math.sin(elapsed * 1.8 + i),
                Math.sin(angle) * radius
            )
        })

        this._updateFlashlight(fearLevel, bpm, dt)

        // Dust drift
        if (this.dustPoints) {
            this._dustPhase += dt * 0.15
            this.dustPoints.rotation.y += dt * 0.005
            const pos = this.dustPoints.geometry.attributes.position
            for (let i = 0; i < pos.count; i++) {
                const base = 0.2 + ((i * 7.3) % 3.5)
                pos.setY(i, base + Math.sin(this._dustPhase + i * 2.1) * 0.1)
            }
            pos.needsUpdate = true
        }

        // Fear desaturation (role-relative)
        const baseExposure = this.role === 'prey' ? 2.6 : 0.95
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
    setRole(role) {
        this.role = role
        if (role === 'prey') {
            if (this.scene.fog)        this.scene.fog.density = 0.015
            if (this.ambientLight)     this.ambientLight.intensity = 1.2
            if (this.hemisphereLight)  this.hemisphereLight.intensity = 1.4
            this.renderer.toneMappingExposure = 2.6
            if (this.mapData?.roomLights) {
                for (const { light } of this.mapData.roomLights) {
                    if (light.userData) light.userData.flickerMultiplier = 1.2
                }
            }
            this.setFlashlightVisible(false)   // Prey starts WITHOUT flashlight
        } else {
            if (this.scene.fog)        this.scene.fog.density = 0.05
            if (this.ambientLight)     this.ambientLight.intensity = 0.1
            if (this.hemisphereLight)  this.hemisphereLight.intensity = 0.15
            this.renderer.toneMappingExposure = 0.95
            if (this.mapData?.roomLights) {
                for (const { light } of this.mapData.roomLights) {
                    if (light.userData) light.userData.flickerMultiplier = 0.3
                }
            }
            this.setFlashlightVisible(true)    // Hunter starts WITH flashlight
        }
    }

    render(scene, camera) {
        this.renderer.render(scene ?? this.scene, camera ?? this.camera)
    }

    raycastCollision(ray) {
        this._raycaster.set(ray.origin, ray.direction)
        this._raycaster.near = 0
        this._raycaster.far  = 50
        const meshes = this.collisionMeshes.map(c => c.mesh)
        const hits   = this._raycaster.intersectObjects(meshes, true)
        return hits.length > 0 ? hits[0] : null
    }

    // ─────────────────────────────────────────────────────────────
    // INTERACTIVE DOORS
    // ─────────────────────────────────────────────────────────────
    tryInteractDoor(playerPos) {
        let nearest = null
        let nearestDist = Infinity
        for (const door of this.doors) {
            const d = playerPos.distanceTo(door.position)
            if (d < 2.5 && d < nearestDist) {
                nearest = door
                nearestDist = d
            }
        }
        if (!nearest) return false

        nearest.isOpen = !nearest.isOpen
        if (nearest.isOpen) {
            nearest.mesh.visible = false
            const idx = this.collisionMeshes.indexOf(nearest.collider)
            if (idx !== -1) this.collisionMeshes.splice(idx, 1)
        } else {
            nearest.mesh.visible = true
            if (!this.collisionMeshes.includes(nearest.collider)) {
                this.collisionMeshes.push(nearest.collider)
            }
        }
        this._occlusionDirty = true
        return true
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

    updateOcclusion(playerPos) {
        if (!this.rooms.length) return
        const here = this.findRoomContaining(playerPos)
        if (!here) {
            if (this._lastVisibleRoom !== null) {
                this._lastVisibleRoom = null
                for (const obj of this._roomTagged) obj.visible = true
            }
            return
        }
        if (!this._occlusionDirty && here === this._lastVisibleRoom) return
        this._lastVisibleRoom = here
        this._occlusionDirty  = false

        const visible = new Set([here])
        const conns   = this.roomConnections.get(here) ?? []
        for (const conn of conns) {
            if (conn.door.isOpen) visible.add(conn.neighbor)
        }

        for (const obj of this._roomTagged) {
            const rooms = obj.userData.rooms
            if (!rooms || rooms.length === 0) { obj.visible = true; continue }
            obj.visible = rooms.some(r => visible.has(r))
        }
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
}
