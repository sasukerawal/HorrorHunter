// src/assets.js — Async GLB Asset Manager
// Waits for ALL models to load before game starts;
// handles scale normalisation and yaw correction per model.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'

// ─── MANIFEST ──────────────────────────────────────────────────────────────
// maxDim:   normalise the bounding-box longest axis to this world-unit size.
// yawOffset: extra Y-rotation (radians) applied at load time so the model
//            faces the correct "forward" direction inside the scene.
export const PROP_MODEL_MANIFEST = [
    {
        key:       'horrorDoll',
        url:       '/models/horror_doll.glb',
        maxDim:    1.4,      // about knee-height – feels like a creepy doll on the floor
        yawOffset: Math.PI,  // flip to face into room
    },
    {
        key:       'horrorMask',
        url:       '/models/horror_mask.glb',
        maxDim:    0.55,     // wall-hung mask size
        yawOffset: Math.PI,
    },
    {
        key:       'horrorMonster',
        url:       '/models/horror_monster.glb',
        maxDim:    2.2,      // upright figure, slightly taller than player eye-level
        yawOffset: Math.PI,
    },
    {
        key:       'smilyHorrorMonster',
        url:       '/models/smily_horror_monster.glb',
        maxDim:    1.8,
        yawOffset: Math.PI,
    },
]

// ─── MANAGER ───────────────────────────────────────────────────────────────
export class AssetManager {
    constructor() {
        this.loader    = new GLTFLoader()
        this.models    = new Map()      // key → THREE.Group (normalised scene root)
        this.modelDefs = new Map(PROP_MODEL_MANIFEST.map(d => [d.key, d]))
        this._ready    = false
    }

    /**
     * Load every model in the manifest.
     * Returns a Promise that resolves when ALL models have settled (pass or fail).
     */
    loadAll(manifest = PROP_MODEL_MANIFEST) {
        const tasks = manifest.map(def => this._loadOne(def))
        return Promise.allSettled(tasks).then(results => {
            const ok   = results.filter(r => r.status === 'fulfilled').length
            const fail = results.filter(r => r.status === 'rejected').length
            console.log(`[Assets] ${ok}/${manifest.length} GLB models loaded (${fail} failed)`)
            this._ready = true
            return this
        })
    }

    _loadOne(def) {
        return new Promise((resolve, reject) => {
            this.loader.load(
                def.url,
                (gltf) => {
                    const root = gltf.scene

                    // ── 1. Apply yaw correction so model faces +Z ──
                    root.rotation.y = def.yawOffset ?? 0

                    // ── 2. Normalise scale to maxDim (longest axis) ──
                    if (def.maxDim) {
                        const box = new THREE.Box3().setFromObject(root)
                        const size = new THREE.Vector3()
                        box.getSize(size)
                        const longest = Math.max(size.x, size.y, size.z)
                        if (longest > 0) {
                            const s = def.maxDim / longest
                            root.scale.set(s, s, s)
                        }
                    }

                    // ── 3. Snap base to y=0 so models sit on the floor ──
                    const box2 = new THREE.Box3().setFromObject(root)
                    root.position.y -= box2.min.y   // shift so min.y == 0

                    this.models.set(def.key, root)
                    this.modelDefs.set(def.key, def)
                    resolve(root)
                },
                undefined,
                (err) => {
                    console.warn(`[Assets] Failed to load ${def.url}:`, err?.message ?? err)
                    reject(err)
                }
            )
        })
    }

    /** Deep-clone a loaded model (safe for static meshes without skinning) */
    clone(key) {
        const src = this.models.get(key)
        if (!src) return null
        return cloneSkeleton(src)   // works for animated AND static
    }

    isReady()        { return this._ready }
    has(key)         { return this.models.has(key) }
    getDef(key)      { return this.modelDefs.get(key) }
}
