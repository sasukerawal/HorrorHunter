// src/map.js — Procedural Haunted Hospital (3×3 grid, GLB props, room tagging for occlusion)
import * as THREE from 'three'

// ─────────────────────────────────────────────────────────────────
// TEXTURE MANIFEST — wall.png & floor.png are the two new textures
// ─────────────────────────────────────────────────────────────────
const TEXTURES = {
    wall:      'wall.png',
    floor:     'floor.png',
}

// ─────────────────────────────────────────────────────────────────
// BLUEPRINT — 8 rooms in a 3×3 grid (NE corner empty).
// ─────────────────────────────────────────────────────────────────
export const MAP_BLUEPRINT = [
    { x:   0, z:   0, w: 14, h: 14, type: 'room', name: 'Reception Hall'    },
    { x:  14, z:   0, w: 14, h: 14, type: 'room', name: 'Operating Theater' },
    { x: -14, z:   0, w: 14, h: 14, type: 'room', name: 'Containment Ward'  },
    { x:   0, z:  14, w: 14, h: 14, type: 'room', name: 'Observation Deck'  },
    { x:   0, z: -14, w: 14, h: 14, type: 'room', name: 'Morgue'            },
    { x:  14, z: -14, w: 14, h: 14, type: 'room', name: 'Surgical Prep'     },
    { x: -14, z: -14, w: 14, h: 14, type: 'room', name: 'ICU Ward'          },
    { x: -14, z:  14, w: 14, h: 14, type: 'room', name: 'Pharmacy'          },
]

const DOOR_CONNECTIONS = [
    ['Reception Hall',    'Operating Theater'],
    ['Reception Hall',    'Containment Ward'],
    ['Reception Hall',    'Observation Deck'],
    ['Reception Hall',    'Morgue'],
    ['Containment Ward',  'ICU Ward'],
    ['Containment Ward',  'Pharmacy'],
    ['Observation Deck',  'Pharmacy'],
    ['Morgue',            'Surgical Prep'],
    ['Operating Theater', 'Surgical Prep'],
]

const WALL_HEIGHT    = 4
const WALL_THICKNESS = 0.3
const DOOR_WIDTH     = 2.4
const DOOR_HEIGHT    = 2.6
const DOOR_SAFE_RADIUS = 3.5

export const SPAWN_HUNTER = new THREE.Vector3(  0, 1.7,  0)
export const SPAWN_PREY   = new THREE.Vector3(-14, 1.7, 14)

// ─────────────────────────────────────────────────────────────────
// TEXTURE LOADER (cached)
// ─────────────────────────────────────────────────────────────────
let _texCache = null
function loadTextures(renderer) {
    if (_texCache) return _texCache
    const loader   = new THREE.TextureLoader()
    const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 8

    const load = (file, repeatX = 4, repeatY = 4) => {
        const tex = loader.load(`/textures/${file}`,
            undefined, undefined,
            (err) => console.warn('[MapTex] Failed to load', file, err)
        )
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = Math.min(8, maxAniso)
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        tex.repeat.set(repeatX, repeatY)
        return tex
    }

    _texCache = {
        wall:  load(TEXTURES.wall,  3, 3),    // wall repeats 3x on each face
        floor: load(TEXTURES.floor, 5, 5),    // floor tiles repeat more
    }
    return _texCache
}

function createMaterials(textures) {
    // MeshLambertMaterial — diffuse-only, no PBR BRDF. ~3× cheaper per fragment.
    // The scene is dark horror; specular highlights are invisible anyway.
    const wallMat  = new THREE.MeshLambertMaterial({
        map:   textures?.wall  ?? null,
        color: '#cccccc',
    })
    const floorMat = new THREE.MeshLambertMaterial({
        map:   textures?.floor ?? null,
        color: '#cccccc',
    })
    return {
        wall:       wallMat,
        floor:      floorMat,
        ceiling:    new THREE.MeshLambertMaterial({ color: '#2a2a2a' }),
        door:       new THREE.MeshLambertMaterial({ color: '#5a3a20' }),
        locker:     new THREE.MeshLambertMaterial({ color: '#2a3138' }),
        lockerDoor: new THREE.MeshLambertMaterial({ color: '#1d242a' }),
    }
}

function freezeStatic(mesh) {
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    return mesh
}

function placeInstanced(scene, geo, mat, transforms, roomName, tagRooms = null) {
    if (!transforms.length) return null
    const mesh = new THREE.InstancedMesh(geo, mat, transforms.length)
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.userData.rooms = [roomName]

    const dummy = new THREE.Object3D()
    transforms.forEach(({ pos, rotX = 0, rotY = 0, rotZ = 0, scale = 1 }, i) => {
        dummy.position.set(pos.x, pos.y, pos.z)
        dummy.rotation.set(rotX, rotY, rotZ)
        dummy.scale.setScalar(scale)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
    mesh.matrixAutoUpdate = false
    scene.add(mesh)
    if (tagRooms) tagRooms(mesh, [roomName])
    return mesh
}

// ─────────────────────────────────────────────────────────────────
// MAIN GENERATOR
// assetManager is optional — pass the loaded AssetManager to place GLB props.
// ─────────────────────────────────────────────────────────────────
export function generateMap(scene, renderer = null, assetManager = null) {
    const textures = loadTextures(renderer)
    const mats     = createMaterials(textures)

    const collisionMeshes = []
    const roomLights      = []
    const doors           = []
    const ventZones       = []
    const lockers         = []
    const roomObjects     = new Map(MAP_BLUEPRINT.map(room => [room.name, []]))
    const allRoomObjects  = new Set()

    const tagRooms = (obj, roomNames) => {
        const names = Array.isArray(roomNames) ? roomNames : [roomNames]
        obj.userData.rooms = names
        allRoomObjects.add(obj)
        for (const roomName of names) {
            const list = roomObjects.get(roomName)
            if (list && !list.includes(obj)) list.push(obj)
        }
    }

    const registerCollision = (mesh, roomNames = null, castsShadow = false) => {
        mesh.castShadow    = castsShadow
        mesh.receiveShadow = castsShadow
        freezeStatic(mesh)
        scene.add(mesh)
        mesh.updateMatrixWorld(true)
        collisionMeshes.push({ mesh, box: new THREE.Box3().setFromObject(mesh) })
        if (roomNames) tagRooms(mesh, roomNames)
        return mesh
    }

    const roomEdges = MAP_BLUEPRINT.map(r => ({
        name: r.name,
        left:  r.x - r.w / 2, right: r.x + r.w / 2,
        front: r.z - r.h / 2, back:  r.z + r.h / 2,
    }))

    const neighborOf = (roomName, side) => {
        const thisRoom = roomEdges.find(r => r.name === roomName)
        if (!thisRoom) return null
        for (const other of roomEdges) {
            if (other.name === roomName) continue
            if (side === 'east'  && Math.abs(thisRoom.right - other.left)  < 1 &&
                                     thisRoom.front < other.back && thisRoom.back > other.front) return other.name
            if (side === 'west'  && Math.abs(thisRoom.left  - other.right) < 1 &&
                                     thisRoom.front < other.back && thisRoom.back > other.front) return other.name
            if (side === 'north' && Math.abs(thisRoom.back  - other.front) < 1 &&
                                     thisRoom.left  < other.right && thisRoom.right > other.left) return other.name
            if (side === 'south' && Math.abs(thisRoom.front - other.back)  < 1 &&
                                     thisRoom.left  < other.right && thisRoom.right > other.left) return other.name
        }
        return null
    }

    const shouldHaveDoor = (roomName, side) => {
        const other = neighborOf(roomName, side)
        if (!other) return false
        return DOOR_CONNECTIONS.some(([a, b]) =>
            (a === roomName && b === other) || (b === roomName && a === other)
        )
    }

    // Wall dedup — adjacent rooms share boundaries
    const builtWalls = new Set()

    MAP_BLUEPRINT.forEach((room) => {
        const { x, z, w, h, name } = room

        // ── Floor ──
        const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, h), mats.floor)
        floor.position.set(x, -0.075, z)
        floor.name = `floor_${name}`
        registerCollision(floor, [name], false)

        // ── Ceiling ──
        const ceil = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, h), mats.ceiling)
        ceil.position.set(x, WALL_HEIGHT + 0.075, z)
        ceil.name = `ceiling_${name}`
        registerCollision(ceil, [name], false)

        // ── Walls ──
        const wallArgs = [
            { cx: x,         cz: z + h / 2, length: w, axis: 'x', side: 'north' },
            { cx: x,         cz: z - h / 2, length: w, axis: 'x', side: 'south' },
            { cx: x + w / 2, cz: z,         length: h, axis: 'z', side: 'east'  },
            { cx: x - w / 2, cz: z,         length: h, axis: 'z', side: 'west'  },
        ]

        wallArgs.forEach(({ cx, cz, length, axis, side }) => {
            const key = axis === 'z'
                ? `Z|${cx.toFixed(2)}|${cz.toFixed(2)}`
                : `X|${cz.toFixed(2)}|${cx.toFixed(2)}`
            if (builtWalls.has(key)) return
            builtWalls.add(key)

            const neighbor  = neighborOf(name, side)
            const wallRooms = neighbor ? [name, neighbor] : [name]

            _buildWallSegment(scene, collisionMeshes, mats, mats.wall, {
                cx, cz, length, height: WALL_HEIGHT,
                thick: WALL_THICKNESS, axis,
                hasDoor: shouldHaveDoor(name, side),
                name: `wall_${name}_${side}`,
                rooms: wallRooms,
            }, doors, tagRooms)
        })

        // ── Room Light ──
        const isHorrorRoom = ['Morgue', 'Containment Ward', 'ICU Ward'].includes(name)
        const lightColor   = isHorrorRoom ? 0xff5544 : 0xccddff
        const baseI        = 5.0
        const lightRange   = Math.max(w, h) * 1.4

        const roomLight = new THREE.PointLight(lightColor, baseI, lightRange, 1.5)
        roomLight.position.set(x, WALL_HEIGHT - 0.3, z)
        roomLight.castShadow = false
        roomLight.userData.baseIntensity     = baseI
        roomLight.userData.flickerMultiplier = 1.0
        roomLight.userData.flickerStrength   = isHorrorRoom ? 0.9 : 0.5
        scene.add(roomLight)
        tagRooms(roomLight, [name])
        roomLights.push({ light: roomLight, name })
    })

    // ── Extraction zone (Surgical Prep) ──
    const extractionRoom = MAP_BLUEPRINT.find(r => r.name === 'Surgical Prep')
    if (extractionRoom) _addExtractionZone(scene, extractionRoom.x, extractionRoom.z, tagRooms)

    // ── Blood decals ──
    _addBloodDecals(scene, tagRooms)

    // ── GLB props (replaces all old procedural props) ──
    if (assetManager && assetManager.isReady()) {
        _placeGLBProps(scene, collisionMeshes, assetManager, doors, lockers, tagRooms)
    } else {
        // Fallback: place simple lockers so there's at least a hiding spot
        _placeFallbackLockers(scene, collisionMeshes, mats, doors, lockers, tagRooms)
    }

    // ── Health pickups ──
    const healthPickups = []
    _spawnHealthPickups(scene, healthPickups, doors, tagRooms)

    console.log(
        `[MapSystem] ${MAP_BLUEPRINT.length} rooms | ` +
        `${collisionMeshes.length} collision meshes | ` +
        `${doors.length} doors | ${lockers.length} lockers | ` +
        `${healthPickups.length} health pickups | ${roomLights.length} lights`
    )

    return {
        collisionMeshes,
        roomLights,
        doors,
        ventZones,
        lockers,
        healthPickups,
        rooms: MAP_BLUEPRINT.map(r => ({ name: r.name, x: r.x, z: r.z, w: r.w, h: r.h })),
        roomObjects,
        allRoomObjects,
        spawnHunter:      SPAWN_HUNTER.clone(),
        spawnPrey:        SPAWN_PREY.clone(),
        extractionCenter: new THREE.Vector3(extractionRoom?.x ?? 14, 0, extractionRoom?.z ?? -14),
        extractionRadius: 3,
    }
}

// ─────────────────────────────────────────────────────────────────
// WALL SEGMENT BUILDER
// ─────────────────────────────────────────────────────────────────
function _buildWallSegment(scene, collisionMeshes, mats, mat, opts, doors = null, tagRooms = null) {
    const { cx, cz, length, height, thick, axis, hasDoor, name, rooms = null } = opts

    if (!hasDoor) {
        const geo  = axis === 'x'
            ? new THREE.BoxGeometry(length, height, thick)
            : new THREE.BoxGeometry(thick, height, length)
        const mesh = new THREE.Mesh(geo, mat)
        mesh.position.set(cx, height / 2, cz)
        mesh.name          = name
        mesh.castShadow    = false
        mesh.receiveShadow = false
        freezeStatic(mesh)
        scene.add(mesh)
        mesh.updateMatrixWorld(true)
        collisionMeshes.push({ mesh, box: new THREE.Box3().setFromObject(mesh) })
        if (rooms && tagRooms) tagRooms(mesh, rooms)
        return
    }

    const halfLength = (length - DOOR_WIDTH) / 2
    if (halfLength <= 0) return

    for (const side of [-1, 1]) {
        const geo  = axis === 'x'
            ? new THREE.BoxGeometry(halfLength, height, thick)
            : new THREE.BoxGeometry(thick, height, halfLength)
        const mesh = new THREE.Mesh(geo, mat)
        if (axis === 'x') {
            mesh.position.set(cx + side * (halfLength / 2 + DOOR_WIDTH / 2), height / 2, cz)
        } else {
            mesh.position.set(cx, height / 2, cz + side * (halfLength / 2 + DOOR_WIDTH / 2))
        }
        mesh.name          = `${name}_seg${side > 0 ? 'R' : 'L'}`
        mesh.castShadow    = false
        mesh.receiveShadow = false
        freezeStatic(mesh)
        scene.add(mesh)
        mesh.updateMatrixWorld(true)
        collisionMeshes.push({ mesh, box: new THREE.Box3().setFromObject(mesh) })
        if (rooms && tagRooms) tagRooms(mesh, rooms)
    }

    // Lintel
    const lintelGeo = axis === 'x'
        ? new THREE.BoxGeometry(DOOR_WIDTH + 0.1, 0.3, thick + 0.05)
        : new THREE.BoxGeometry(thick + 0.05, 0.3, DOOR_WIDTH + 0.1)
    const lintel = new THREE.Mesh(lintelGeo, mat)
    lintel.position.set(cx, height - 0.15, cz)
    lintel.castShadow = false
    lintel.receiveShadow = false
    freezeStatic(lintel)
    scene.add(lintel)
    if (rooms && tagRooms) tagRooms(lintel, rooms)

    // Toggleable door
    if (doors !== null && height >= DOOR_HEIGHT) {
        const doorGeo  = axis === 'x'
            ? new THREE.BoxGeometry(DOOR_WIDTH - 0.05, DOOR_HEIGHT, thick + 0.02)
            : new THREE.BoxGeometry(thick + 0.02, DOOR_HEIGHT, DOOR_WIDTH - 0.05)
        const doorMesh = new THREE.Mesh(doorGeo, mats.door)
        doorMesh.position.set(cx, DOOR_HEIGHT / 2, cz)
        doorMesh.castShadow    = false
        doorMesh.receiveShadow = false
        freezeStatic(doorMesh)
        doorMesh.updateMatrixWorld(true)
        const doorCollider = { mesh: doorMesh, box: new THREE.Box3().setFromObject(doorMesh) }
        collisionMeshes.push(doorCollider)

        const door = {
            mesh:     doorMesh,
            collider: doorCollider,
            position: new THREE.Vector3(cx, DOOR_HEIGHT / 2, cz),
            isOpen:   false,
            rooms:    rooms ?? [],
        }
        doorMesh.userData.doorState = door
        scene.add(doorMesh)
        if (rooms && tagRooms) tagRooms(doorMesh, rooms)
        doors.push(door)
    }
}

// ─────────────────────────────────────────────────────────────────
// GLB PROP PLACEMENT
// One prop per room, chosen from the manifest, spaced well away
// from doors, spawns and each other so the player isn't blocked.
// ─────────────────────────────────────────────────────────────────
function _isNearSpawn(px, pz, radius = 5.5) {
    for (const sp of [SPAWN_HUNTER, SPAWN_PREY]) {
        if (Math.hypot(px - sp.x, pz - sp.z) < radius) return true
    }
    return false
}

function _isNearDoor(px, pz, doors, radius = DOOR_SAFE_RADIUS) {
    for (const d of doors) {
        if (Math.hypot(px - d.position.x, pz - d.position.z) < radius) return true
    }
    return false
}

// Placement table — one entry per room with hand-tuned local offsets.
// Offsets are relative to the room centre; yaw is in radians.
const GLB_PLACEMENTS = [
    // roomName,            modelKey,            dx,   dz,    yaw
    ['Reception Hall',    'horrorMonster',       2,   -3,    Math.PI * 0.75],
    ['Operating Theater', 'horrorDoll',         -3,    3,    0            ],
    ['Containment Ward',  'smilyHorrorMonster',  3,   -2,    Math.PI      ],
    ['Observation Deck',  'horrorMask',         -2,    2,    Math.PI / 2  ],
    ['Morgue',            'horrorDoll',          4,    3,   -Math.PI / 3  ],
    ['Surgical Prep',     'horrorMonster',      -3,   -4,    Math.PI / 4  ],
    ['ICU Ward',          'smilyHorrorMonster', -3,    3,    Math.PI * 1.5],
    ['Pharmacy',          'horrorMask',          3,   -3,    Math.PI      ],
]

function _placeGLBProps(scene, collisionMeshes, assetManager, doors, lockers, tagRooms) {
    let placed = 0

    for (const [roomName, modelKey, dx, dz, yaw] of GLB_PLACEMENTS) {
        if (!assetManager.has(modelKey)) continue

        const room = MAP_BLUEPRINT.find(r => r.name === roomName)
        if (!room) continue

        const px = room.x + dx
        const pz = room.z + dz

        // Safety checks — skip if too close to a door or spawn
        if (_isNearSpawn(px, pz)) continue
        if (_isNearDoor(px, pz, doors)) continue

        const clone = assetManager.clone(modelKey)
        if (!clone) continue

        clone.position.set(px, 0, pz)
        clone.rotation.y = yaw
        clone.name = `glbProp_${modelKey}_${roomName}`

        // ── Traverse for shadows & collision ──
        const propBox = new THREE.Box3().setFromObject(clone)
        const propSize = new THREE.Vector3()
        propBox.getSize(propSize)

        // Add a simple invisible AABB collider so player can't walk through
        // large props (thin collider = half the XZ footprint, full height)
        const colW = Math.min(propSize.x * 0.7, 1.2)
        const colD = Math.min(propSize.z * 0.7, 1.2)
        const colGeo = new THREE.BoxGeometry(colW, propSize.y, colD)
        const colMesh = new THREE.Mesh(
            colGeo,
            new THREE.MeshBasicMaterial({ visible: false })
        )
        colMesh.position.set(px, propSize.y / 2, pz)
        colMesh.name = `${clone.name}_col`
        freezeStatic(colMesh)
        scene.add(colMesh)
        colMesh.updateMatrixWorld(true)
        collisionMeshes.push({ mesh: colMesh, box: new THREE.Box3().setFromObject(colMesh) })

        clone.traverse(child => {
            if (child.isMesh) {
                child.castShadow    = false
                child.receiveShadow = false
                child.matrixAutoUpdate = false
                child.updateMatrix()
            }
        })

        scene.add(clone)
        if (tagRooms) tagRooms(clone, [roomName])
        placed++
    }

    // Also place a locker in each room (separate from GLB props)
    _placeFallbackLockers(scene, collisionMeshes, null, doors, lockers, tagRooms)

    console.log(`[MapSystem] ${placed} GLB props placed`)
}

// ─────────────────────────────────────────────────────────────────
// LOCKER — simple box locker in every room so prey can hide
// ─────────────────────────────────────────────────────────────────
function _placeFallbackLockers(scene, collisionMeshes, mats, doors, lockers, tagRooms) {
    // One locker per room on an interior wall, clear of doors & spawns
    const lockerSidePriority = ['south', 'north', 'east', 'west']

    const lockerMat     = mats ? mats.locker     : new THREE.MeshStandardMaterial({ color: '#2a3138', roughness: 0.55, metalness: 0.7 })
    const lockerDoorMat = mats ? mats.lockerDoor : new THREE.MeshStandardMaterial({ color: '#1d242a', roughness: 0.45, metalness: 0.8 })

    for (const room of MAP_BLUEPRINT) {
        const { x, z, w, h, name } = room
        let placed = false

        for (const side of lockerSidePriority) {
            let px, pz, faceYaw
            const off = 0.6
            if (side === 'north') { px = x; pz = z + h / 2 - off; faceYaw = Math.PI   }
            else if (side === 'south') { px = x; pz = z - h / 2 + off; faceYaw = 0     }
            else if (side === 'east')  { px = x + w / 2 - off; pz = z; faceYaw = Math.PI / 2    }
            else                       { px = x - w / 2 + off; pz = z; faceYaw = -Math.PI / 2   }

            if (_isNearSpawn(px, pz, 4.5)) continue
            if (_isNearDoor(px, pz, doors, DOOR_SAFE_RADIUS)) continue

            _buildLocker(scene, collisionMeshes, lockerMat, lockerDoorMat, px, pz, faceYaw, name, lockers, tagRooms)
            placed = true
            break
        }

        if (!placed) {
            // Last resort: centre of room
            const px = x, pz = z
            _buildLocker(scene, collisionMeshes, lockerMat, lockerDoorMat, px, pz, 0, name, lockers, tagRooms)
        }
    }
}

function _buildLocker(scene, collisionMeshes, lockerMat, lockerDoorMat, px, pz, faceYaw, roomName, lockers, tagRooms) {
    const group = new THREE.Group()
    group.position.set(px, 0, pz)
    group.rotation.y = faceYaw
    group.name = `locker_${roomName}`

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.85, 2.0, 0.55), lockerMat)
    body.position.set(0, 1.0, 0)
    body.castShadow = false
    group.add(body)

    const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(0.78, 1.85, 0.04), lockerDoorMat)
    doorPanel.position.set(0, 1.0, -0.285)
    group.add(doorPanel)

    scene.add(group)
    group.updateMatrixWorld(true)

    const colliderBox = new THREE.Box3().setFromObject(body)
    collisionMeshes.push({ mesh: body, box: colliderBox })
    if (tagRooms) {
        tagRooms(group, [roomName])
        tagRooms(body, [roomName])
    }

    // Entry trigger — stand in front of locker
    const facing = new THREE.Vector3(Math.sin(faceYaw), 0, Math.cos(faceYaw))
    const entry  = new THREE.Vector3(px, 1.7, pz).addScaledVector(facing, 0.95)
    lockers.push({ position: entry, lockedYaw: faceYaw, roomName, mesh: group })
}

// ─────────────────────────────────────────────────────────────────
// EXTRACTION ZONE
// ─────────────────────────────────────────────────────────────────
function _addExtractionZone(scene, x, z, tagRooms) {
    const outerMat = new THREE.MeshBasicMaterial({
        color: '#00ff44', side: THREE.DoubleSide, transparent: true, opacity: 0.4, depthWrite: false,
    })
    const outer = new THREE.Mesh(new THREE.RingGeometry(2.5, 2.8, 16), outerMat)
    outer.rotation.x = -Math.PI / 2
    outer.position.set(x, 0.02, z)
    scene.add(outer)
    if (tagRooms) tagRooms(outer, ['Surgical Prep'])

    const innerMat = new THREE.MeshBasicMaterial({
        color: '#00ff44', side: THREE.DoubleSide, transparent: true, opacity: 0.25, depthWrite: false, wireframe: true,
    })
    const inner = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.0, 12), innerMat)
    inner.rotation.x = -Math.PI / 2
    inner.position.set(x, 0.03, z)
    scene.add(inner)
    if (tagRooms) tagRooms(inner, ['Surgical Prep'])
}

// ─────────────────────────────────────────────────────────────────
// BLOOD DECALS
// ─────────────────────────────────────────────────────────────────
function _addBloodDecals(scene, tagRooms) {
    const mat = new THREE.MeshBasicMaterial({
        color: '#440000', transparent: true, opacity: 0.8,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, side: THREE.DoubleSide,
    })
    const spots = [
        [-5, -5], [4, 3], [-3, -12], [12, -3], [-12, 4], [3, 12],
        [-12, -5], [5, -12], [-12, -12], [12, -12], [-12, 12], [-2, 12], [12, 2],
    ]
    const geo = new THREE.CircleGeometry(1, 12)
    const byRoom = new Map()
    spots.forEach(([bx, bz], i) => {
        const r = MAP_BLUEPRINT.find(room =>
            bx >= room.x - room.w / 2 && bx <= room.x + room.w / 2 &&
            bz >= room.z - room.h / 2 && bz <= room.z + room.h / 2
        )
        if (!r) return
        if (!byRoom.has(r.name)) byRoom.set(r.name, [])
        byRoom.get(r.name).push({
            pos: { x: bx, y: 0.02, z: bz },
            rotX: -Math.PI / 2,
            rotZ: ((i * 97) % 360) * Math.PI / 180,
            scale: 0.4 + ((i * 37) % 90) / 100,
        })
    })
    for (const [roomName, transforms] of byRoom) {
        placeInstanced(scene, geo, mat, transforms, roomName, tagRooms)
    }
}

// ─────────────────────────────────────────────────────────────────
// HEALTH PICKUPS — glowing green crosses
// ─────────────────────────────────────────────────────────────────
function _spawnHealthPickups(scene, healthPickups, doors, tagRooms) {
    const crossMat = new THREE.MeshBasicMaterial({
        color: '#00ff66', transparent: true, opacity: 0.9,
    })

    const farFromDoors = (px, pz) => {
        for (const d of doors) {
            if (Math.hypot(px - d.position.x, pz - d.position.z) < 2.5) return false
        }
        return true
    }

    let count = 0
    for (const room of MAP_BLUEPRINT) {
        if (room.type !== 'room') continue
        const numPickups = 1 + Math.floor(Math.random() * 2)
        for (let i = 0; i < numPickups; i++) {
            const px = room.x + (Math.random() - 0.5) * (room.w - 4)
            const pz = room.z + (Math.random() - 0.5) * (room.h - 4)
            if (!farFromDoors(px, pz)) continue
            if (_isNearSpawn(px, pz, 3.5)) continue

            const group = new THREE.Group()
            group.position.set(px, 0.6, pz)

            const vBar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.12), crossMat)
            group.add(vBar)

            const hBar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.12), crossMat)
            hBar.position.y = 0.06
            group.add(hBar)

            scene.add(group)
            if (tagRooms) tagRooms(group, [room.name])

            healthPickups.push({
                mesh: group,
                position: new THREE.Vector3(px, 0.6, pz),
                roomName: room.name,
                collected: false,
                phaseOffset: Math.random() * Math.PI * 2
            })
            count++
        }
    }
    console.log(`[MapSystem] ${count} health pickups placed`)
}
