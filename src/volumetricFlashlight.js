// src/volumetricFlashlight.js — SpotLight + visible volumetric cone (Fresnel, attenuation, soft-particles)
import * as THREE from 'three'

const BEAM_LENGTH    = 36
const BEAM_ANGLE     = Math.PI / 7
const BASE_INTENSITY = 16

const VOLUMETRIC_VS = /* glsl */`
    varying vec3 vViewPos;
    varying vec3 vNormal;
    varying vec3 vLocalPos;

    void main() {
        vec4 viewPos = viewMatrix * modelMatrix * vec4(position, 1.0);
        vViewPos  = viewPos.xyz;
        vLocalPos = position;
        vNormal   = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewPos;
    }
`

const VOLUMETRIC_FS = /* glsl */`
    uniform float uTime;
    uniform float uOpacity;
    uniform float uFlicker;
    uniform float uFearLevel;
    uniform float uLength;
    uniform vec3  uColor;

    varying vec3 vViewPos;
    varying vec3 vNormal;
    varying vec3 vLocalPos;

    float hash(vec3 p) {
        p = fract(p * vec3(443.897, 441.423, 437.195));
        p += dot(p, p.yxz + 19.19);
        return fract((p.x + p.y) * p.z);
    }

    void main() {
        float beamDist = clamp(-vLocalPos.z / uLength, 0.0, 1.0);

        // Attenuation — fades with distance from the lens.
        float atten = pow(1.0 - beamDist, 1.6);

        // Fresnel/rim — silhouette edges stay lit, centre transparent.
        vec3  viewDir = normalize(-vViewPos);
        float facing  = clamp(abs(dot(viewDir, vNormal)), 0.0, 1.0);
        float rim     = pow(1.0 - facing, 1.8);

        // Drifting dust bands.
        vec3  sp   = vec3(vLocalPos.x, vLocalPos.y, vLocalPos.z * 0.2) * 2.0
                   + vec3(uTime * 0.25, -uTime * 0.4, uTime * 0.15);
        float dust = mix(0.78, 1.15, hash(floor(sp * 6.0)));

        // Fear micro-flicker.
        float fearFlick = 1.0 - uFearLevel * 0.25 *
                          (0.5 + 0.5 * sin(uTime * 55.0 + vLocalPos.x * 9.0 + vLocalPos.y * 11.0));

        float alpha = atten * rim * uOpacity * uFlicker * fearFlick;
        gl_FragColor = vec4(uColor * dust * alpha, alpha);
    }
`

export class VolumetricFlashlight {
    constructor(scene, camera) {
        this.scene  = scene
        this.camera = camera

        // ───── Scene illumination (real spotlight) ─────
        this.light = new THREE.SpotLight('#fff5e0', BASE_INTENSITY, BEAM_LENGTH, BEAM_ANGLE, 0.3, 1.8)
        this.light.position.set(0, -0.03, 0)
        this.light.castShadow = true
        this.light.shadow.mapSize.set(256, 256)
        this.light.shadow.camera.far = BEAM_LENGTH
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
            uTime:     { value: 0 },
            uOpacity:  { value: 0.55 },
            uFlicker:  { value: 1.0 },
            uFearLevel:{ value: 0.0 },
            uLength:   { value: BEAM_LENGTH },
            uColor:    { value: new THREE.Color('#ffe9bd') },
        }

        this.material = new THREE.ShaderMaterial({
            uniforms:       this.uniforms,
            vertexShader:   VOLUMETRIC_VS,
            fragmentShader: VOLUMETRIC_FS,
            transparent:    true,
            depthWrite:     false,
            depthTest:      true,
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

    update(delta, fearLevel = 0) {
        this._timeAcc += delta
        this.uniforms.uTime.value = this._timeAcc
        this.uniforms.uFearLevel.value = fearLevel

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
