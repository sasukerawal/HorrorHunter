// src/volumetricFlashlight.js — SpotLight + visible volumetric cone
import * as THREE from 'three'

const BEAM_LENGTH    = 40
const BEAM_ANGLE     = Math.PI / 7   // ~25.7 deg — tight, believable torch
const BASE_INTENSITY = 40            // bright enough to read at full hunter exposure

const VOLUMETRIC_VS = /* glsl */`
    varying vec3 vLocalPos;
    varying vec3 vWorldPos;
    varying vec3 vViewPos;
    varying vec3 vViewNormal;

    void main() {
        vLocalPos = position;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vec4 viewPos  = viewMatrix * worldPos;
        vWorldPos  = worldPos.xyz;
        vViewPos   = viewPos.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewPos;
    }
`

const VOLUMETRIC_FS = /* glsl */`
    uniform float uTime;
    uniform float uIntensity;
    uniform float uRange;
    uniform float uFear;
    uniform float uFlicker;
    uniform vec3  uColor;

    varying vec3 vLocalPos;
    varying vec3 vWorldPos;
    varying vec3 vViewPos;
    varying vec3 vViewNormal;

    float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }

    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    void main() {
        float beamT = clamp(-vLocalPos.z / uRange, 0.0, 1.0);

        // Dense near the lens, fade toward the tip
        float distanceFade = pow(1.0 - beamT, 1.55);
        float lensFade     = smoothstep(0.02, 0.11, beamT);

        // Fresnel: edges glow, direct line-of-sight is almost clear
        vec3  viewDir = normalize(-vViewPos);
        float facing  = clamp(abs(dot(viewDir, normalize(vViewNormal))), 0.0, 1.0);
        float rim  = pow(1.0 - facing, 1.65);
        float core = pow(facing, 4.0) * 0.16;

        // Two-scale drifting dust — avoids repeating-texture look
        vec2 driftA = vWorldPos.xz * 1.8 + vec2(uTime * 0.22, -uTime * 0.17);
        vec2 driftB = vec2(vWorldPos.y * 2.7 - uTime * 0.31, vLocalPos.z * 0.13 + uTime * 0.12);
        float dustA = noise(driftA);
        float dustB = noise(driftB);
        float dust  = mix(0.72, 1.18, dustA * 0.65 + dustB * 0.35);

        // Thin rolling bands — reads as suspended particles
        float bands = 0.88 + 0.12 * sin(vLocalPos.z * 1.15 + uTime * 3.2 + dustA * 5.0);

        // Fear micro-flicker
        float fearFlicker = 1.0 - uFear * 0.32 *
            (0.5 + 0.5 * sin(uTime * 63.0 + vLocalPos.x * 10.0 + vLocalPos.y * 13.0));

        float mist  = distanceFade * lensFade * (rim + core) * dust * bands * fearFlicker;
        float alpha = mist * uIntensity * uFlicker;
        alpha = clamp(alpha, 0.0, 0.72);

        vec3 color = uColor * (0.78 + rim * 0.65 + dust * 0.20);
        gl_FragColor = vec4(color * alpha, alpha);
    }
`

export class VolumetricFlashlight {
    constructor(scene, camera) {
        this.scene  = scene
        this.camera = camera

        // ───── Scene illumination (real spotlight) ─────
        this.light = new THREE.SpotLight('#fff5e0', BASE_INTENSITY, BEAM_LENGTH, BEAM_ANGLE, 0.25, 1.6)
        this.light.position.set(0, -0.03, 0)
        camera.add(this.light)
        camera.add(this.light.target)
        this.light.target.position.set(0, 0, -10)

        // Warm fill so close surfaces don't go pitch-black at the hunter's feet
        this.fill = new THREE.PointLight('#fff5e0', 2.5, 4)
        camera.add(this.fill)

        // ───── Visible volumetric cone ─────
        const baseRadius = Math.tan(BEAM_ANGLE) * BEAM_LENGTH
        const geo = new THREE.ConeGeometry(baseRadius, BEAM_LENGTH, 32, 12, true)
        geo.translate(0, -BEAM_LENGTH / 2, 0)  // apex at origin
        geo.rotateX(Math.PI / 2)               // axis along -Z (camera forward)

        this.uniforms = {
            uTime:      { value: 0 },
            uColor:     { value: new THREE.Color('#ffe9bd') },
            uIntensity: { value: 1.0 },
            uRange:     { value: BEAM_LENGTH },
            uFear:      { value: 0.0 },
            uFlicker:   { value: 1.0 },
        }

        this.material = new THREE.ShaderMaterial({
            uniforms:       this.uniforms,
            vertexShader:   VOLUMETRIC_VS,
            fragmentShader: VOLUMETRIC_FS,
            transparent:    true,
            depthWrite:     false,
            depthTest:      false,
            blending:       THREE.AdditiveBlending,
            side:           THREE.DoubleSide,
        })

        this.cone = new THREE.Mesh(geo, this.material)
        this.cone.frustumCulled = false

        // Cone lives in its own scene rendered in a separate pass after
        // the main scene so it composites correctly on top.
        this.fxScene = new THREE.Scene()
        this.fxScene.add(this.cone)

        this._isOn           = true
        this._flickerTimer   = 0
        this._timeAcc        = 0
        this._currentFlicker = 1.0
    }

    update(delta, fearLevel = 0) {
        this._timeAcc += delta
        this.uniforms.uTime.value      = this._timeAcc
        this.uniforms.uFear.value      = fearLevel
        this.uniforms.uIntensity.value = 0.85 + fearLevel * 0.28

        if (fearLevel > 0.8) {
            this._flickerTimer += delta
            if (this._flickerTimer > 0.04) {
                this._flickerTimer   = 0
                this._currentFlicker = Math.random() < 0.22 ? 0.05 : (0.4 + Math.random() * 0.7)
            }
        } else if (fearLevel > 0.6) {
            this._flickerTimer += delta
            if (this._flickerTimer > 0.05 + Math.random() * 0.08) {
                this._flickerTimer   = 0
                this._currentFlicker = Math.random() < 0.15 ? 0.15 : (0.6 + Math.random() * 0.5)
            }
        } else {
            this._currentFlicker = 1.0
        }
        this.uniforms.uFlicker.value = this._currentFlicker

        // Cone lives in fxScene — sync its world transform from the camera each frame.
        this.cone.position.copy(this.camera.position)
        this.cone.quaternion.copy(this.camera.quaternion)
    }

    toggle(isOn) {
        this._isOn = !!isOn
        this.light.visible = this._isOn
        this.fill.visible  = this._isOn
        this.cone.visible  = this._isOn
    }

    isOn()               { return this._isOn }
    getCurrentFlicker()  { return this._currentFlicker }

    dispose() {
        this.material.dispose()
        this.cone.geometry.dispose()
    }
}
