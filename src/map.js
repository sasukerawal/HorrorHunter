// src/map.js — Procedural Haunted Hospital (3×3 grid, hiding props, room tagging for occlusion culling)
import * as THREE from 'three'

// ─────────────────────────────────────────────────────────────────
// TEXTURE MANIFEST
// ─────────────────────────────────────────────────────────────────
const TEXTURES = {
    victorian: 'LincolnsInnDrawingRoom03.jpeg',
    stone:     'Daglistugan_900k_u1_v1.jpeg',
    attic:     'Vinden_900k_u1_v1.jpeg',
    floor_tile:'room_fl.jpg',
    stair:     'Trappa1_900k_u1_v1.jpeg',
}

// ─────────────────────────────────────────────────────────────────
// BLUEPRINT — 8 rooms in a 3×3 grid (NE corner empty).
// ─────────────────────────────────────────────────────────────────
export const MAP_BLUEPRINT = [
    { x:   0, z:   0, w: 14, h: 14, type: 'room', name: 'Reception Hall',    textureKey: 'victorian', floorKey: 'floor_tile' },
    { x:  14, z:   0, w: 14, h: 14, type: 'room', name: 'Operating Theater', textureKey: 'stone',     floorKey: 'floor_tile' },
    { x: -14, z:   0, w: 14, h: 14, type: 'room', name: 'Containment Ward',  textureKey: 'stone',     floorKey: 'stair'      },
    { x:   0, z:  14, w: 14, h: 14, type: 'room', name: 'Observation Deck',  textureKey: 'attic',     floorKey: 'attic'      },
    { x:   0, z: -14, w: 14, h: 14, type: 'room', name: 'Morgue',            textureKey: 'stair',     floorKey: 'stair'      },
    { x:  14, z: -14, w: 14, h: 14, type: 'room', name: 'Surgical Prep',     textureKey: 'victorian', floorKey: 'floor_tile' },
    { x: -14, z: -14, w: 14, h: 14, type: 'room', name: 'ICU Ward',          textureKey: 'victorian', floorKey: 'stair'      },
    { x: -14, z:  14, w: 14, h: 14, type: 'room', name: 'Pharmacy',          textureKey: 'attic',     floorKey: 'floor_tile' },
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
const DOOR_SAFE_RADIUS = 3.0   // hiding props avoid this radius around any door

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
        victorian:  load(TEXTURES.victorian,  4, 4),
        stone:      load(TEXTURES.stone,      3, 3),
        attic:      load(TEXTURES.attic,      2, 2),
        floor_tile: load(TEXTURES.floor_tile, 5, 5),
        stair:      load(TEXTURES.stair,      3, 3),
    }
    return _texCache
}

function createMaterials(textures) {
    const matFor = (texKey, roughness = 0.92) => new THREE.MeshStandardMaterial({
        map:       textures ? (textures[texKey] ?? null) : null,
        color:     '#d8d4cc',
        roughness,
        metalness: 0.0,
    })
    return {
        victorian:  matFor('victorian',  0.90),
        stone:      matFor('stone',      0.96),
        attic:      matFor('attic',      0.94),
        floor_tile: matFor('floor_tile', 0.95),
        stair:      matFor('stair',      0.98),
        door:       new THREE.MeshStandardMaterial({ color: '#5a3a20', roughness: 0.95, metalness: 0.05 }),
        ceiling:    new THREE.MeshStandardMaterial({ color: '#3a3a3a', roughness: 0.95 }),
        generic:    new THREE.MeshStandardMaterial({ color: '#888888', roughness: 0.88 }),
        curtain:    new THREE.MeshStandardMaterial({
            color: '#3d2a2a', roughness: 0.95, metalness: 0.0,
            side: THREE.DoubleSide, transparent: true, opacity: 0.92,
        }),
        locker:     new THREE.MeshStandardMaterial({ color: '#2a3138', roughness: 0.55, metalness: 0.7 }),
        lockerDoor: new THREE.MeshStandardMaterial({ color: '#1d242a', roughness: 0.45, metalness: 0.8 }),
        gurney:     new THREE.MeshStandardMaterial({ color: '#aaaaaa', roughness: 0.5,  metalness: 0.6 }),
        gurneyPad:  new THREE.MeshStandardMaterial({ color: '#3a1e1e', roughness: 0.95, metalness: 0.0 }),
        crate:      new THREE.MeshStandardMaterial({ color: '#5a3d22', roughness: 0.95, metalness: 0.05 }),
    }
}

// ─────────────────────────────────────────────────────────────────
// MAIN GENERATOR
// ─────────────────────────────────────────────────────────────────
export function generateMap(scene, renderer = null) {
    const textures = loadTextures(renderer)
    const mats     = createMaterials(textures)

    const collisionMeshes = []
    const roomLights      = []
    const doors           = []
    const ventZones       = []
    const lockers         = []
    const roomObjects     = new Map(MAP_BLUEPRINT.map(room => [room.name, []]))
    const allRoomObjects  = new Set()

    const roomMat = (texKey) => mats[texKey] ?? mats.generic

    const tagRooms = (obj, roomNames) => {
        const names = Array.isArray(roomNames) ? roomNames : [roomNames]
        obj.userData.rooms = names
        allRoomObjects.add(obj)
        for (const roomName of names) {
            const list = roomObjects.get(roomName)
            if (list && !list.includes(obj)) list.push(obj)
        }
    }

    const registerCollision = (mesh, roomNames = null, castsShadow = true) => {
        mesh.castShadow    = castsShadow
        mesh.receiveShadow = castsShadow // don't receive if not casting to save perf
        scene.add(mesh)
        collisionMeshes.push({ mesh, box: new THREE.Box3().setFromObject(mesh) })
        if (roomNames) tagRooms(mesh, roomNames)
        return mesh
    }

    const roomEdges = MAP_BLUEPRINT.map(r => ({
        name: r.name,
        left:  r.x - r.w / 2,  right: r.x + r.w / 2,
        front: r.z - r.h / 2,  back:  r.z + r.h / 2,
    }))

    // For a wall on `side` of `roomName`, returns the neighbor room name (or null) + connection meta
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
        const { x, z, w, h, name, textureKey, floorKey } = room
        const wallM  = roomMat(textureKey)
        const floorM = roomMat(floorKey ?? textureKey)
        const ceilM  = mats.ceiling

        // Floor + ceiling — single-room tag
        // Floor + ceiling — no shadows needed for these large static planes
        const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, h), floorM)
        floor.position.set(x, -0.075, z)
        floor.name = `floor_${name}`
        registerCollision(floor, [name], false)

        const ceil = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, h), ceilM)
        ceil.position.set(x, WALL_HEIGHT + 0.075, z)
        ceil.name = `ceiling_${name}`
        registerCollision(ceil, [name], false)

        // Walls AT the boundary (not inset) so adjacent rooms truly share them
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

            // Tag this wall with both rooms it borders (for occlusion: visible from either side)
            const neighbor = neighborOf(name, side)
            const wallRooms = neighbor ? [name, neighbor] : [name]

            _buildWallSegment(scene, collisionMeshes, mats, wallM, {
                cx, cz, length, height: WALL_HEIGHT,
                thick: WALL_THICKNESS, axis,
                hasDoor: shouldHaveDoor(name, side),
                name: `wall_${name}_${side}`,
                rooms: wallRooms,
            }, doors, tagRooms)
        })

        // ── LIGHTING ──
        const isHorrorRoom = ['Morgue', 'Containment Ward', 'ICU Ward'].includes(name)
        const lightColor   = isHorrorRoom ? 0xff5544 : 0xccddff
        const baseI        = 5.0
        const lightRange   = Math.max(w, h) * 1.4

        const roomLight = new THREE.PointLight(lightColor, baseI, lightRange, 1.5)
        roomLight.position.set(x, WALL_HEIGHT - 0.3, z)
        roomLight.castShadow = false
        roomLight.userData.baseIntensity     = baseI
        roomLight.userData.flickerMultiplier = 1.0
        scene.add(roomLight)
        tagRooms(roomLight, [name])

        const flickerStrength = isHorrorRoom ? 0.9 : 0.5
        roomLight.userData.flickerStrength = flickerStrength
        // removed internal flicker loop — now handled in engine.js update()
        roomLights.push({ light: roomLight, name })

        // Keep room lighting to one non-shadowed point light per room for lower frame cost.
    })

    // Extraction in Surgical Prep
    const extractionRoom = MAP_BLUEPRINT.find(r => r.name === 'Surgical Prep')
    if (extractionRoom) _addExtractionZone(scene, extractionRoom.x, extractionRoom.z, tagRooms)

    _addBloodDecals(scene, tagRooms)
    _addDebrisClusters(scene, collisionMeshes, tagRooms)

    // Hiding props — curtains, lockers, gurneys/crates
    spawnHidingProps(scene, collisionMeshes, mats, doors, lockers, tagRooms)
    _pruneSpawnBlockers(scene, collisionMeshes, lockers)

    // Health pickups — glowing green crosses scattered in rooms
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
// WALL SEGMENT BUILDER (with optional door gap + door mesh)
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
        mesh.receiveShadow = false // Walls don't need to receive shadows in this lighting style
        scene.add(mesh)
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
        scene.add(mesh)
        collisionMeshes.push({ mesh, box: new THREE.Box3().setFromObject(mesh) })
        if (rooms && tagRooms) tagRooms(mesh, rooms)
    }

    // Lintel
    const lintelGeo = axis === 'x'
        ? new THREE.BoxGeometry(DOOR_WIDTH + 0.1, 0.3, thick + 0.05)
        : new THREE.BoxGeometry(thick + 0.05, 0.3, DOOR_WIDTH + 0.1)
    const lintelMat = new THREE.MeshStandardMaterial({
        map:       _texCache?.stair ?? null,
        color:     '#a89888',
        roughness: 0.95,
    })
    const lintel = new THREE.Mesh(lintelGeo, lintelMat)
    lintel.position.set(cx, height - 0.15, cz)
    lintel.castShadow = false
    lintel.receiveShadow = false
    scene.add(lintel)
    if (rooms && tagRooms) tagRooms(lintel, rooms)

    // Toggleable door
    if (doors !== null && height >= DOOR_HEIGHT) {
        const doorGeo  = axis === 'x'
            ? new THREE.BoxGeometry(DOOR_WIDTH - 0.05, DOOR_HEIGHT, thick + 0.02)
            : new THREE.BoxGeometry(thick + 0.02, DOOR_HEIGHT, DOOR_WIDTH - 0.05)
        const doorMesh = new THREE.Mesh(doorGeo, mats.door)
        doorMesh.position.set(cx, DOOR_HEIGHT / 2, cz)
        doorMesh.castShadow    = true
        doorMesh.receiveShadow = false
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
// HIDING PROPS — curtains (no collision), lockers (trigger), gurneys/crates (AABB)
// ─────────────────────────────────────────────────────────────────
function _isNearSpawn(box, radius = 5.2) {
    const spawns = [SPAWN_HUNTER, SPAWN_PREY]
    for (const spawn of spawns) {
        const closestX = Math.max(box.min.x, Math.min(spawn.x, box.max.x))
        const closestZ = Math.max(box.min.z, Math.min(spawn.z, box.max.z))
        const dx = closestX - spawn.x
        const dz = closestZ - spawn.z
        if (Math.sqrt(dx * dx + dz * dz) < radius) return true
    }
    return false
}

function _markSpawnBlocker(mesh, root = mesh) {
    mesh.userData.spawnBlocker = true
    mesh.userData.spawnRoot = root
}

function _pruneSpawnBlockers(scene, collisionMeshes, lockers) {
    const removedRoots = new Set()
    for (let i = collisionMeshes.length - 1; i >= 0; i--) {
        const entry = collisionMeshes[i]
        const mesh = entry.mesh
        if (!mesh?.userData?.spawnBlocker) continue
        entry.box.setFromObject(mesh)
        if (!_isNearSpawn(entry.box)) continue

        const root = mesh.userData.spawnRoot ?? mesh
        if (!removedRoots.has(root)) {
            root.parent?.remove(root)
            scene.remove(root)
            removedRoots.add(root)
        }
        collisionMeshes.splice(i, 1)
    }

    for (let i = lockers.length - 1; i >= 0; i--) {
        if (!lockers[i].mesh.parent) lockers.splice(i, 1)
    }

    if (removedRoots.size) {
        console.log(`[MapSystem] Removed ${removedRoots.size} spawn-blocking props`)
    }
}

export function spawnHidingProps(scene, collisionMeshes, mats, doors, lockers, tagRooms) {
    // Returns true if (px, pz) is at least DOOR_SAFE_RADIUS from every door
    const farFromDoors = (px, pz) => {
        for (const d of doors) {
            const dx = px - d.position.x, dz = pz - d.position.z
            if (Math.sqrt(dx * dx + dz * dz) < DOOR_SAFE_RADIUS) return false
        }
        return true
    }
    const farFromSpawns = (px, pz) => {
        if (Math.abs(px - SPAWN_HUNTER.x) < 4.0 && Math.abs(pz - SPAWN_HUNTER.z) < 4.0) return false
        if (Math.abs(px - SPAWN_PREY.x)   < 4.0 && Math.abs(pz - SPAWN_PREY.z)   < 4.0) return false
        return true
    }

    let curtains = 0, lockerCount = 0, gurneys = 0, crates = 0

    for (const room of MAP_BLUEPRINT) {
        if (room.type !== 'room') continue
        const { x, z, w, h, name } = room

        // ── 1 LOCKER per room — placed against an interior wall, facing room center ──
        const lockerSide = _pickWallSideForLocker(room, doors)
        if (lockerSide) {
            const { pos, faceYaw } = _lockerPlacement(room, lockerSide)
            if (farFromDoors(pos.x, pos.z) && farFromSpawns(pos.x, pos.z)) {
                _buildLocker(scene, collisionMeshes, mats, pos, faceYaw, name, lockers, tagRooms)
                lockerCount++
            }
        }

        // ── 1-2 CURTAINS hanging from ceiling ──
        const curtainCount = 1 + Math.floor(Math.random() * 2)
        for (let i = 0; i < curtainCount; i++) {
            const px = x + (Math.random() - 0.5) * (w - 4)
            const pz = z + (Math.random() - 0.5) * (h - 4)
            if (!farFromDoors(px, pz) || !farFromSpawns(px, pz)) continue
            _buildCurtain(scene, mats, px, pz, name, tagRooms)
            curtains++
        }

        // ── 1-2 GURNEYS ──
        const gurneyCount = 1 + Math.floor(Math.random() * 2)
        for (let i = 0; i < gurneyCount; i++) {
            const px = x + (Math.random() - 0.5) * (w - 3)
            const pz = z + (Math.random() - 0.5) * (h - 3)
            if (!farFromDoors(px, pz) || !farFromSpawns(px, pz)) continue
            _buildGurney(scene, collisionMeshes, mats, px, pz, name, tagRooms)
            gurneys++
        }

        // ── 0-2 CRATES ──
        const crateCount = Math.floor(Math.random() * 3)
        for (let i = 0; i < crateCount; i++) {
            const px = x + (Math.random() - 0.5) * (w - 2)
            const pz = z + (Math.random() - 0.5) * (h - 2)
            if (!farFromDoors(px, pz) || !farFromSpawns(px, pz)) continue
            _buildCrate(scene, collisionMeshes, mats, px, pz, name, tagRooms)
            crates++
        }
    }

    console.log(`[HidingProps] ${lockerCount} lockers | ${curtains} curtains | ${gurneys} gurneys | ${crates} crates`)
}

function _pickWallSideForLocker(room, doors) {
    // Pick a wall that doesn't have a door near its midpoint
    const sides = ['north', 'south', 'east', 'west']
    const shuffled = sides.sort(() => Math.random() - 0.5)
    const wallMid = (side) => {
        if (side === 'north') return new THREE.Vector3(room.x,                room.y ?? 0, room.z + room.h / 2)
        if (side === 'south') return new THREE.Vector3(room.x,                room.y ?? 0, room.z - room.h / 2)
        if (side === 'east')  return new THREE.Vector3(room.x + room.w / 2,   room.y ?? 0, room.z)
        return                       new THREE.Vector3(room.x - room.w / 2,   room.y ?? 0, room.z)
    }
    for (const side of shuffled) {
        const mid = wallMid(side)
        let conflict = false
        for (const d of doors) {
            if (Math.abs(d.position.x - mid.x) < 2 && Math.abs(d.position.z - mid.z) < 2) {
                conflict = true; break
            }
        }
        if (!conflict) return side
    }
    return null
}

function _lockerPlacement(room, side) {
    // Stand the locker just inside the wall and face the room center
    const off = 0.55
    let pos, faceYaw
    if (side === 'north') {
        pos = new THREE.Vector3(room.x + (Math.random() - 0.5) * (room.w - 3), 1.0, room.z + room.h / 2 - off)
        faceYaw = Math.PI                                  // looking south (toward -z = room center)
    } else if (side === 'south') {
        pos = new THREE.Vector3(room.x + (Math.random() - 0.5) * (room.w - 3), 1.0, room.z - room.h / 2 + off)
        faceYaw = 0                                        // looking north (+z)
    } else if (side === 'east') {
        pos = new THREE.Vector3(room.x + room.w / 2 - off, 1.0, room.z + (Math.random() - 0.5) * (room.h - 3))
        faceYaw = Math.PI / 2                              // looking west (-x)
    } else {
        pos = new THREE.Vector3(room.x - room.w / 2 + off, 1.0, room.z + (Math.random() - 0.5) * (room.h - 3))
        faceYaw = -Math.PI / 2                             // looking east (+x)
    }
    return { pos, faceYaw }
}

function _buildLocker(scene, collisionMeshes, mats, pos, faceYaw, roomName, lockers, tagRooms) {
    const group = new THREE.Group()
    group.position.copy(pos)
    group.rotation.y = faceYaw
    group.name = `locker_${roomName}`

    // Body
    const bodyGeo = new THREE.BoxGeometry(0.85, 2.0, 0.55)
    const body    = new THREE.Mesh(bodyGeo, mats.locker)
    body.castShadow = false
    body.receiveShadow = false
    _markSpawnBlocker(body, group)
    body.position.set(0, 0, 0)
    group.add(body)

    // Door panel (slightly inset)
    const doorGeo = new THREE.BoxGeometry(0.78, 1.85, 0.04)
    const door    = new THREE.Mesh(doorGeo, mats.lockerDoor)
    door.position.set(0, 0, -0.28)
    door.castShadow = false
    door.receiveShadow = false
    group.add(door)

    // Vent slats
    const slatMat = new THREE.MeshStandardMaterial({ color: '#0a0d10', roughness: 0.9 })
    for (let i = 0; i < 5; i++) {
        const slat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.01), slatMat)
        slat.position.set(0, 0.6 - i * 0.12, -0.30)
        slat.castShadow = false
        slat.receiveShadow = false
        group.add(slat)
    }

    scene.add(group)

    // Collider — body box (lockers are solid AABB)
    const colliderBox = new THREE.Box3().setFromObject(body)
    collisionMeshes.push({ mesh: body, box: colliderBox })
    if (tagRooms) {
        tagRooms(group, [roomName])
        tagRooms(body, [roomName])
    }

    // Locker entry trigger position — stand 0.9m in front (along facing direction)
    const facing = new THREE.Vector3(Math.sin(faceYaw), 0, Math.cos(faceYaw))
    const entry  = pos.clone().add(facing.clone().multiplyScalar(0.95))
    entry.y = 1.7
    lockers.push({
        position: entry,
        lockedYaw: faceYaw,
        roomName,
        mesh: group,
    })
}

function _buildCurtain(scene, mats, px, pz, roomName, tagRooms) {
    // Tall thin double-sided plane — visual occluder, no collision
    const w = 1.4 + Math.random() * 0.6
    const h = 2.6
    const geo = new THREE.PlaneGeometry(w, h, 1, 1)
    const mesh = new THREE.Mesh(geo, mats.curtain)
    mesh.position.set(px, h / 2, pz)
    mesh.rotation.y = Math.random() * Math.PI
    mesh.castShadow = false
    mesh.receiveShadow = false
    scene.add(mesh)
    if (tagRooms) tagRooms(mesh, [roomName])

    // Curtain rail (thin metal bar above)
    const railGeo = new THREE.BoxGeometry(w + 0.2, 0.04, 0.04)
    const railMat = new THREE.MeshStandardMaterial({ color: '#888', roughness: 0.4, metalness: 0.8 })
    const rail = new THREE.Mesh(railGeo, railMat)
    rail.position.set(px, h + 0.05, pz)
    rail.rotation.y = mesh.rotation.y
    rail.castShadow = false
    rail.receiveShadow = false
    scene.add(rail)
    if (tagRooms) tagRooms(rail, [roomName])
}

function _buildGurney(scene, collisionMeshes, mats, px, pz, roomName, tagRooms) {
    const group = new THREE.Group()
    group.position.set(px, 0, pz)
    group.rotation.y = Math.random() * Math.PI
    group.name = `gurney_${roomName}`

    // Frame top
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 0.85), mats.gurney)
    frame.position.set(0, 0.78, 0)
    frame.castShadow = false
    frame.receiveShadow = false
    group.add(frame)

    // Padded mattress
    const pad = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.1, 0.78), mats.gurneyPad)
    pad.position.set(0, 0.86, 0)
    pad.castShadow = false
    pad.receiveShadow = false
    group.add(pad)

    // Legs
    const legMat = mats.gurney
    const legPos = [[0.85, 0.35], [-0.85, 0.35], [0.85, -0.35], [-0.85, -0.35]]
    for (const [lx, lz] of legPos) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.78, 6), legMat)
        leg.position.set(lx, 0.39, lz)
        leg.castShadow = false
        leg.receiveShadow = false
        group.add(leg)
    }

    scene.add(group)

    // AABB collider — use the frame for collision
    const colliderBox = new THREE.Box3().setFromObject(frame)
    _markSpawnBlocker(frame, group)
    collisionMeshes.push({ mesh: frame, box: colliderBox })
    if (tagRooms) {
        tagRooms(group, [roomName])
        tagRooms(frame, [roomName])
    }
}

function _buildCrate(scene, collisionMeshes, mats, px, pz, roomName, tagRooms) {
    const size = 0.7 + Math.random() * 0.5
    const geo  = new THREE.BoxGeometry(size, size, size)
    const mesh = new THREE.Mesh(geo, mats.crate)
    mesh.position.set(px, size / 2, pz)
    mesh.rotation.y = Math.random() * Math.PI
    mesh.castShadow    = false
    mesh.receiveShadow = false
    _markSpawnBlocker(mesh)
    scene.add(mesh)
    collisionMeshes.push({ mesh, box: new THREE.Box3().setFromObject(mesh) })
    if (tagRooms) tagRooms(mesh, [roomName])
}

// ─────────────────────────────────────────────────────────────────
// EXTRACTION ZONE
// ─────────────────────────────────────────────────────────────────
function _addExtractionZone(scene, x, z, tagRooms) {
    const outerMat = new THREE.MeshBasicMaterial({
        color: '#00ff44', side: THREE.DoubleSide, transparent: true, opacity: 0.4, depthWrite: false,
    })
    const outer = new THREE.Mesh(new THREE.RingGeometry(2.5, 2.8, 32), outerMat)
    outer.rotation.x = -Math.PI / 2
    outer.position.set(x, 0.02, z)
    scene.add(outer)
    if (tagRooms) tagRooms(outer, ['Surgical Prep'])

    const innerMat = new THREE.MeshBasicMaterial({
        color: '#00ff44', side: THREE.DoubleSide, transparent: true, opacity: 0.25, depthWrite: false, wireframe: true,
    })
    const inner = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.0, 24), innerMat)
    inner.rotation.x = -Math.PI / 2
    inner.position.set(x, 0.03, z)
    scene.add(inner)
    if (tagRooms) tagRooms(inner, ['Surgical Prep'])

    const gl = new THREE.PointLight('#00ff44', 2.5, 10)
    gl.position.set(x, 3.5, z)
    gl.castShadow = false
    scene.add(gl)
    if (tagRooms) tagRooms(gl, ['Surgical Prep'])
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
    spots.forEach(([bx, bz]) => {
        const geo  = new THREE.CircleGeometry(0.4 + Math.random() * 0.9, 12)
        const mesh = new THREE.Mesh(geo, mat)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set(bx, 0.02, bz)
        scene.add(mesh)
        // Tag with whichever room contains the spot
        if (tagRooms) {
            const r = MAP_BLUEPRINT.find(r =>
                bx >= r.x - r.w / 2 && bx <= r.x + r.w / 2 &&
                bz >= r.z - r.h / 2 && bz <= r.z + r.h / 2
            )
            if (r) tagRooms(mesh, [r.name])
        }
    })
}

// ─────────────────────────────────────────────────────────────────
// DEBRIS CLUSTERS — keep clear of spawns
// ─────────────────────────────────────────────────────────────────
function _addDebrisClusters(scene, collisionMeshes, tagRooms) {
    const debrisMat = new THREE.MeshStandardMaterial({ color: '#3a2818', roughness: 0.95, metalness: 0.05 })

    const safeZone = (px, pz) => {
        if (Math.abs(px - SPAWN_HUNTER.x) < 3 && Math.abs(pz - SPAWN_HUNTER.z) < 3) return false
        if (Math.abs(px - SPAWN_PREY.x)   < 3 && Math.abs(pz - SPAWN_PREY.z)   < 3) return false
        return true
    }

    let placed = 0
    for (const room of MAP_BLUEPRINT) {
        if (room.type !== 'room') continue
        const count = 3 + Math.floor(Math.random() * 4)
        for (let i = 0; i < count; i++) {
            const px = room.x + (Math.random() - 0.5) * (room.w - 2)
            const pz = room.z + (Math.random() - 0.5) * (room.h - 2)
            if (!safeZone(px, pz)) continue
            const pieces = 1 + Math.floor(Math.random() * 3)
            for (let j = 0; j < pieces; j++) {
                const sw = 0.2 + Math.random() * 0.5
                const sh = 0.15 + Math.random() * 0.4
                const sd = 0.2 + Math.random() * 0.5
                const geo  = Math.random() < 0.7
                    ? new THREE.BoxGeometry(sw, sh, sd)
                    : new THREE.SphereGeometry(sw * 0.4, 6, 6)
                const mesh = new THREE.Mesh(geo, debrisMat)
                mesh.position.set(
                    px + (Math.random() - 0.5) * 0.8,
                    sh / 2,
                    pz + (Math.random() - 0.5) * 0.8
                )
                mesh.rotation.y = Math.random() * Math.PI
                mesh.rotation.z = (Math.random() - 0.5) * 0.25
                mesh.castShadow    = false // Debris clusters too small for shadows
                mesh.receiveShadow = false
                _markSpawnBlocker(mesh)
                scene.add(mesh)
                collisionMeshes.push({ mesh, box: new THREE.Box3().setFromObject(mesh) })
                if (tagRooms) tagRooms(mesh, [room.name])
            }
            placed++
        }
    }
    console.log(`[MapSystem] ${placed} debris clusters placed`)
}

// ─────────────────────────────────────────────────────────────────
// HEALTH PICKUPS — glowing green crosses, 1-2 per room
// ─────────────────────────────────────────────────────────────────
function _spawnHealthPickups(scene, healthPickups, doors, tagRooms) {
    const crossMat = new THREE.MeshStandardMaterial({
        color: '#00ff66', emissive: '#00ff44', emissiveIntensity: 0.8,
        roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.9,
    })

    const farFromDoors = (px, pz) => {
        for (const d of doors) {
            const dx = px - d.position.x, dz = pz - d.position.z
            if (Math.sqrt(dx * dx + dz * dz) < 2.5) return false
        }
        return true
    }

    let count = 0
    for (const room of MAP_BLUEPRINT) {
        if (room.type !== 'room') continue
        const numPickups = 1 + Math.floor(Math.random() * 2) // 1-2 per room
        for (let i = 0; i < numPickups; i++) {
            const px = room.x + (Math.random() - 0.5) * (room.w - 4)
            const pz = room.z + (Math.random() - 0.5) * (room.h - 4)
            if (!farFromDoors(px, pz)) continue

            const group = new THREE.Group()
            group.position.set(px, 0.6, pz)

            // Vertical bar of the cross
            const vBar = new THREE.Mesh(
                new THREE.BoxGeometry(0.12, 0.4, 0.12),
                crossMat
            )
            group.add(vBar)

            // Horizontal bar of the cross
            const hBar = new THREE.Mesh(
                new THREE.BoxGeometry(0.4, 0.12, 0.12),
                crossMat
            )
            hBar.position.y = 0.06
            group.add(hBar)

            // Glow light
            const glow = new THREE.PointLight('#00ff66', 1.5, 4)
            glow.position.set(0, 0.2, 0)
            glow.castShadow = false
            group.add(glow)

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
