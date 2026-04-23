// src/volumetricFlashlight.js — SpotLight + visible volumetric cone with depth-softened mist
import * as THREE from 'three'

const BEAM_LENGTH    = 36
const BEAM_ANGLE     = Math.PI / 7
const BASE_INTENSITY = 16

const VOLUMETRIC_VS = /* glsl */`
    varying vec3 vLocalPos;
    varying vec3 vWorldPos;
    varying vec3 vViewPos;
    varying vec3 vViewNormal;

    void main() {
        vLocalPos = position;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vec4 viewPos = viewMatrix * worldPos;
        vWorldPos = worldPos.xyz;
        vViewPos = viewPos.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewPos;
    }
`

const VOLUMETRIC_FS = /* glsl */`
    #include <packing>

    uniform float uTime;
    uniform float uIntensity;
    uniform float uRange;
    uniform float uFear;
    uniform float uFlicker;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform float uSoftness;
    uniform vec3  uColor;
    uniform vec2  uResolution;
    uniform sampler2D tDepth;

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

        // Distance attenuation: dense at the lens, fading toward the beam end.
        float distanceFade = pow(1.0 - beamT, 1.55);
        float lensFade = smoothstep(0.02, 0.11, beamT);

        // Fresnel/rim: direct views are clearer; edges hold the visible mist.
        vec3 viewDir = normalize(-vViewPos);
        float facing = clamp(abs(dot(viewDir, normalize(vViewNormal))), 0.0, 1.0);
        float rim = pow(1.0 - facing, 1.65);
        float core = pow(facing, 4.0) * 0.16;

        // Animated dust/mist. Two scales avoid a repeating texture look.
        vec2 driftA = vWorldPos.xz * 1.8 + vec2(uTime * 0.22, -uTime * 0.17);
        vec2 driftB = vec2(vWorldPos.y * 2.7 - uTime * 0.31, vLocalPos.z * 0.13 + uTime * 0.12);
        float dustA = noise(driftA);
        float dustB = noise(driftB);
        float dust = mix(0.72, 1.18, dustA * 0.65 + dustB * 0.35);

        // Thin rolling bands inside the cone, subtle enough to read as particles.
        float bands = 0.88 + 0.12 * sin(vLocalPos.z * 1.15 + uTime * 3.2 + dustA * 5.0);

        // Fear micro-flicker.
        float fearFlicker = 1.0 - uFear * 0.32 *
            (0.5 + 0.5 * sin(uTime * 63.0 + vLocalPos.x * 10.0 + vLocalPos.y * 13.0));

        // Soft-particle depth fade. This keeps the beam from hard-clipping
        // through walls by fading as its fragment approaches scene geometry.
        vec2 uv = gl_FragCoord.xy / uResolution;
        float sceneDepth = texture2D(tDepth, uv).x;
        float sceneViewZ = perspectiveDepthToViewZ(sceneDepth, uCameraNear, uCameraFar);
        float beamViewZ = vViewPos.z;
        float softParticle = smoothstep(0.0, uSoftness, beamViewZ - sceneViewZ);

        float mist = distanceFade * lensFade * (rim + core) * dust * bands * fearFlicker;
        float alpha = mist * softParticle * uIntensity * uFlicker;
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
        this.light = new THREE.SpotLight('#fff5e0', BASE_INTENSITY, BEAM_LENGTH, BEAM_ANGLE, 0.3, 1.8)
        this.light.position.set(0, -0.03, 0)
        camera.add(this.light)
        camera.add(this.light.target)
        this.light.target.position.set(0, 0, -10)

        // Warm fill for the lens itself so close surfaces don't go black.
        this.fill = new THREE.PointLight('#fff5e0', 2, 5)
        camera.add(this.fill)

        // ───── Visible volumetric cone ─────
        const baseRadius = Math.tan(BEAM_ANGLE) * BEAM_LENGTH
        const geo = new THREE.ConeGeometry(baseRadius, BEAM_LENGTH, 32, 12, true)
        geo.translate(0, -BEAM_LENGTH / 2, 0)   // apex at origin
        geo.rotateX(Math.PI / 2)                // axis along -Z (camera forward)

        this.uniforms = {
            uTime:      { value: 0 },
            uColor:     { value: new THREE.Color('#ffe9bd') },
            uIntensity: { value: 1.0 },
            uRange:     { value: BEAM_LENGTH },
            uFear:      { value: 0.0 },
            uFlicker:   { value: 1.0 },
            uCameraNear:{ value: camera.near },
            uCameraFar: { value: camera.far },
            uSoftness:  { value: 2.25 },
            uResolution:{ value: new THREE.Vector2(1, 1) },
            tDepth:     { value: null },
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

        // Cone lives in its own scene so the engine can render it in a
        // dedicated pass, after the main scene's depth buffer is available.
        this.fxScene = new THREE.Scene()
        this.fxScene.add(this.cone)

        this._isOn           = true
        this._flickerTimer   = 0
        this._timeAcc        = 0
        this._currentFlicker = 1.0
    }

    setDepthTexture(depthTexture, width, height, near = this.camera.near, far = this.camera.far) {
        this.uniforms.tDepth.value = depthTexture
        this.uniforms.uResolution.value.set(Math.max(1, width), Math.max(1, height))
        this.uniforms.uCameraNear.value = near
        this.uniforms.uCameraFar.value = far
    }

    update(delta, fearLevel = 0) {
        this._timeAcc += delta
        this.uniforms.uTime.value = this._timeAcc
        this.uniforms.uFear.value = fearLevel
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

        // Cone is in its own scene, so sync its transform to the camera each frame.
        this.cone.position.copy(this.camera.position)
        this.cone.quaternion.copy(this.camera.quaternion)
    }

    toggle(isOn) {
        this._isOn = !!isOn
        this.light.visible = this._isOn
        this.fill.visible  = this._isOn
        this.cone.visible  = this._isOn
    }

    isOn() { return this._isOn }
    getCurrentFlicker() { return this._currentFlicker }

    dispose() {
        this.material.dispose()
        this.cone.geometry.dispose()
    }
}
