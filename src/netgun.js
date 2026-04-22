// src/netgun.js — Hunter Net Gun with projectile animation (enari-engine hitscan + visual net mesh)
import * as THREE from 'three'

export class NetGun {
    constructor(camera, engine, socket, audio = null) {
        this.camera = camera
        this.engine = engine
        this.socket = socket
        this.audio = audio
        this.cooldown = 0
        this.rateOfFire = 0.6
        this.accuracy = 1.0
        this.peerPlayerId = null
        this.preyMeshes = []       // array of prey meshes for multi-player hitscan
        this._activeNets = [] // animated net projectiles
        this._raycaster = new THREE.Raycaster()
        this._raycastTargets = []

        // Bloom (driven by Prey's broadcast fear; expands the hitscan jitter cone)
        // Bloom = baseBloom + (fear * maxJitter) — applied as random offset to the ray direction
        this.baseBloom  = 0.005
        this.maxJitter  = 0.18
        this.peerFear   = 0
        this.peerIsPhasing = false   // when prey is phasing, raycast cannot tag them

        this._setupInput()
        this._createMuzzleFlash()
    }

    _createMuzzleFlash() {
        this.muzzleLight = new THREE.PointLight('#00ffcc', 0, 4)
        this.camera.add(this.muzzleLight)
        this.muzzleLight.position.set(0.3, -0.2, -0.5)
    }

    _setupInput() {
        document.addEventListener('mousedown', (e) => {
            if (e.button === 0) this._fire()
        })
    }

    setPeerPlayerId(id) { this.peerPlayerId = id }
    setPreyMesh(mesh) { this.preyMesh = mesh; this.preyMeshes = [mesh] }
    setPreyMeshes(meshes) { this.preyMeshes = meshes; this.preyMesh = meshes[0] ?? null }
    setAccuracy(accuracy) { this.accuracy = accuracy }
    setPeerFear(f)         { this.peerFear = Math.max(0, Math.min(1, f)) }
    setPeerPhasing(p)      { this.peerIsPhasing = !!p }
    /** Bloom = baseBloom + (fear * maxJitter) — used by HUD to size the crosshair, and by _fire for raycast spread */
    getBloom()             { return this.baseBloom + this.peerFear * this.maxJitter }

    _fire() {
        if (this.cooldown > 0) return

        // Bloom = baseBloom + (fear * maxJitter), plus a small accuracy-based residual
        const bloom  = this.getBloom()
        const spread = bloom + (1 - this.accuracy) * 0.04
        const origin = new THREE.Vector3()
        this.camera.getWorldPosition(origin)

        const dir = new THREE.Vector3()
        this.camera.getWorldDirection(dir)
        dir.x += (Math.random() - 0.5) * spread * 2
        dir.y += (Math.random() - 0.5) * spread * 2
        dir.z += (Math.random() - 0.5) * spread * 2
        dir.normalize()

        // ---- Hitscan raycasting ----
        const meshes = this.engine.getCollisionMeshList()
        this._raycastTargets.length = 0
        for (const mesh of meshes) this._raycastTargets.push(mesh)
        // Add all visible, non-phasing prey meshes
        for (const pm of this.preyMeshes) {
            if (pm && pm.visible && !this.peerIsPhasing) this._raycastTargets.push(pm)
        }

        this._raycaster.set(origin, dir)
        this._raycaster.near = 0
        this._raycaster.far = 30
        const hits = this._raycaster.intersectObjects(this._raycastTargets, true)

        const endpoint = hits.length > 0
            ? hits[0].point.clone()
            : origin.clone().addScaledVector(dir, 28)

        // ---- Visual net projectile (thin cone traveling to endpoint) ----
        this._spawnNetProjectile(origin.clone(), endpoint, dir)

        // ---- Hitscan result ----
        let hitData = null
        if (hits.length > 0) {
            // Check if the hit object is a prey mesh or a child of one
            let hitPrey = false
            let obj = hits[0].object
            while (obj) {
                for (const pm of this.preyMeshes) {
                    if (obj === pm) { hitPrey = true; break }
                }
                if (hitPrey) break
                obj = obj.parent
            }
            hitData = {
                position: { x: hits[0].point.x, y: hits[0].point.y, z: hits[0].point.z },
                hasHit: true,
                hitPrey
            }
        }

        if (this.socket) {
            this.socket.emit('netFired', {
                from: { x: origin.x, y: origin.y, z: origin.z },
                dir: { x: dir.x, y: dir.y, z: dir.z },
                hit: hitData
            })
        }

        // Audio
        if (this.audio) this.audio.playNetFire()

        // Muzzle flash
        this.muzzleLight.intensity = 6
        setTimeout(() => { this.muzzleLight.intensity = 0 }, 80)

        // Viewmodel recoil
        if (this.viewmodel) this.viewmodel.fireRecoil()

        this.cooldown = this.rateOfFire
    }

    _spawnNetProjectile(from, to, dir) {
        // Net is a wireframe torus + trail line traveling to target
        const dist = from.distanceTo(to)

        // Trail line (LineSegments)
        const points = [from.clone(), from.clone()] // starts collapsed, expands in update
        const geo = new THREE.BufferGeometry().setFromPoints(points)
        const mat = new THREE.LineBasicMaterial({ color: '#00ffcc', linewidth: 2 })
        const line = new THREE.Line(geo, mat)
        this.engine.scene.add(line)

        // Small "net" mesh at tip: wireframe sphere
        const netGeo = new THREE.SphereGeometry(0.18, 8, 8)
        const netMat = new THREE.MeshBasicMaterial({ color: '#00ffcc', wireframe: true })
        const netMesh = new THREE.Mesh(netGeo, netMat)
        netMesh.position.copy(from)
        this.engine.scene.add(netMesh)

        this._activeNets.push({
            line, netMesh, geo,
            from: from.clone(),
            to: to.clone(),
            dir: dir.clone(),
            progress: 0,
            speed: 22, // units per second
            dist,
            done: false
        })
    }

    _spawnImpactRing(point) {
        // Expanding ring at impact point
        const geo = new THREE.RingGeometry(0.05, 0.15, 16)
        const mat = new THREE.MeshBasicMaterial({ color: '#00ffcc', side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
        const ring = new THREE.Mesh(geo, mat)
        ring.position.copy(point)
        ring.lookAt(point.clone().add(new THREE.Vector3(0, 1, 0)))
        this.engine.scene.add(ring)

        let scale = 1
        const expand = () => {
            scale += 0.18
            ring.scale.setScalar(scale)
            mat.opacity -= 0.07
            if (mat.opacity > 0.05) requestAnimationFrame(expand)
            else this.engine.scene.remove(ring)
        }
        requestAnimationFrame(expand)
    }

    update(dt) {
        if (this.cooldown > 0) this.cooldown -= dt

        // Animate active net projectiles
        for (let i = this._activeNets.length - 1; i >= 0; i--) {
            const net = this._activeNets[i]
            if (net.done) {
                this.engine.scene.remove(net.line)
                this.engine.scene.remove(net.netMesh)
                this._activeNets.splice(i, 1)
                continue
            }

            net.progress = Math.min(net.progress + net.speed * dt, net.dist)
            const tipPos = net.from.clone().addScaledVector(net.dir, net.progress)
            net.netMesh.position.copy(tipPos)

            // Update trail line endpoints
            const positions = net.geo.attributes.position
            positions.setXYZ(0, net.from.x, net.from.y, net.from.z)
            positions.setXYZ(1, tipPos.x, tipPos.y, tipPos.z)
            positions.needsUpdate = true

            // Arrival
            if (net.progress >= net.dist) {
                net.done = true
                this._spawnImpactRing(net.to)
            }
        }
    }
}
