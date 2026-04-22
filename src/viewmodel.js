// src/viewmodel.js — Procedural First-Person Viewmodels (Net Gun + Flashlight)
import * as THREE from 'three'

export class Viewmodel {
    constructor(camera, role) {
        this.camera = camera
        this.role = role
        this.group = new THREE.Group()
        this._bobPhase = 0

        if (role === 'hunter') {
            this._buildNetGun()
            this._buildFlashlight()
        } else {
            this._buildPreyHands()
        }

        // Position the viewmodel group in front of camera
        this.group.position.set(0.35, -0.35, -0.55)
        camera.add(this.group)
    }

    // ── HUNTER: NET GUN ──
    _buildNetGun() {
        const gunGroup = new THREE.Group()

        // Barrel — long dark cyan cylinder
        const barrelGeo = new THREE.CylinderGeometry(0.025, 0.03, 0.45, 8)
        const barrelMat = new THREE.MeshStandardMaterial({
            color: '#115566',
            roughness: 0.4,
            metalness: 0.7
        })
        const barrel = new THREE.Mesh(barrelGeo, barrelMat)
        barrel.rotation.x = Math.PI / 2
        barrel.position.set(0, 0, -0.1)
        gunGroup.add(barrel)

        // Muzzle cage — wireframe torus at the tip
        const muzzleGeo = new THREE.TorusGeometry(0.04, 0.01, 6, 8)
        const muzzleMat = new THREE.MeshBasicMaterial({
            color: '#00ffcc',
            wireframe: true
        })
        const muzzle = new THREE.Mesh(muzzleGeo, muzzleMat)
        muzzle.position.set(0, 0, -0.34)
        gunGroup.add(muzzle)
        this._muzzleMesh = muzzle

        // Stock / grip — small box behind
        const gripGeo = new THREE.BoxGeometry(0.04, 0.08, 0.06)
        const gripMat = new THREE.MeshStandardMaterial({ color: '#222222', roughness: 0.9 })
        const grip = new THREE.Mesh(gripGeo, gripMat)
        grip.position.set(0, -0.04, 0.12)
        gunGroup.add(grip)

        // Cyan glow ring on barrel
        const ringGeo = new THREE.TorusGeometry(0.032, 0.005, 6, 12)
        const ringMat = new THREE.MeshBasicMaterial({ color: '#00ffcc' })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.position.set(0, 0, -0.06)
        gunGroup.add(ring)

        this.group.add(gunGroup)
        this._gunGroup = gunGroup
    }

    // ── HUNTER: FLASHLIGHT (left hand) ──
    _buildFlashlight() {
        const flGroup = new THREE.Group()

        // Body — rugged grey cylinder
        const bodyGeo = new THREE.CylinderGeometry(0.025, 0.02, 0.2, 8)
        const bodyMat = new THREE.MeshStandardMaterial({
            color: '#555555',
            roughness: 0.7,
            metalness: 0.4
        })
        const body = new THREE.Mesh(bodyGeo, bodyMat)
        body.rotation.x = Math.PI / 2
        flGroup.add(body)

        // Glass tip — semi-transparent emissive cap
        const tipGeo = new THREE.CylinderGeometry(0.026, 0.026, 0.03, 8)
        const tipMat = new THREE.MeshStandardMaterial({
            color: '#ffeecc',
            emissive: '#ffeeaa',
            emissiveIntensity: 0.8,
            transparent: true,
            opacity: 0.7,
            roughness: 0.1
        })
        const tip = new THREE.Mesh(tipGeo, tipMat)
        tip.rotation.x = Math.PI / 2
        tip.position.set(0, 0, -0.11)
        flGroup.add(tip)
        this._flashlightTip = tip

        // Offset to left hand
        flGroup.position.set(-0.55, 0.05, 0)
        this.group.add(flGroup)
        this._flGroup = flGroup
    }

    // ── PREY: simple hands ──
    _buildPreyHands() {
        // Two small boxes representing fists
        const handMat = new THREE.MeshStandardMaterial({
            color: '#8b7355',
            roughness: 0.9
        })

        const rightHand = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 0.04, 0.1),
            handMat
        )
        rightHand.position.set(0.05, -0.02, -0.08)
        this.group.add(rightHand)

        const leftHand = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 0.04, 0.1),
            handMat.clone()
        )
        leftHand.position.set(-0.55, -0.02, -0.08)
        this.group.add(leftHand)

        this._hands = [rightHand, leftHand]
    }

    // ── Fire recoil animation (Hunter only) ──
    fireRecoil() {
        if (!this._gunGroup) return
        // Quick kick-back then return
        const orig = this._gunGroup.position.z
        this._gunGroup.position.z = orig + 0.08
        if (this._muzzleMesh) {
            this._muzzleMesh.material.color.set('#ffffff')
            setTimeout(() => this._muzzleMesh.material.color.set('#00ffcc'), 60)
        }
        setTimeout(() => { this._gunGroup.position.z = orig }, 100)
    }

    // ── Set opacity on every mesh in the viewmodel (used for Phase fade) ──
    setOpacity(opacity) {
        const op = Math.max(0, Math.min(1, opacity))
        this.group.traverse((obj) => {
            if (!obj.material) return
            obj.material.transparent = op < 1
            obj.material.opacity     = op
            obj.material.depthWrite  = op >= 1
        })
    }

    // ── Frame update: Sway & Bob ──
    update(dt, isMoving, isDashing) {
        this._bobPhase += dt * (isMoving ? (isDashing ? 14 : 7) : 1.5)

        const bobAmplitude = isMoving ? (isDashing ? 0.04 : 0.02) : 0.003
        const bobX = Math.cos(this._bobPhase) * bobAmplitude
        const bobY = Math.sin(this._bobPhase * 2) * bobAmplitude

        this.group.position.set(
            0.35 + bobX,
            -0.35 + bobY,
            -0.55
        )
        this.group.rotation.z = bobX * 2 // subtle tilt when walking

        // Flashlight tip flicker synced to engine
        if (this._flashlightTip) {
            this._flashlightTip.material.emissiveIntensity = 0.6 + Math.random() * 0.4
        }
    }
}
