import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three'
import { latLngToVector3 } from './coords.js'

/**
 * Glowing location markers.
 *
 * The requirement is "hundreds to a thousand+ pins, smooth on mobile". A Mesh
 * or Sprite per marker means one draw call each, and a thousand draw calls is
 * where a mid-range phone starts dropping frames regardless of how simple the
 * geometry is.
 *
 * So all markers live in a single InstancedMesh: one draw call total, with
 * per-instance colour and phase pushed in as instanced attributes. Adding or
 * removing a marker rewrites a slice of a typed array rather than touching the
 * scene graph.
 *
 * Capacity is allocated up front and grown by reallocation when exceeded,
 * which keeps the common case (all markers known at load) allocation-free.
 */

const DEFAULT_CAPACITY = 256
const GROWTH_FACTOR = 2

export class MarkerLayer {
  /**
   * @param {object} [options]
   * @param {number} [options.radius] Globe radius the markers sit on
   * @param {number} [options.size] Marker quad size in world units
   * @param {number|string} [options.color] Default marker colour
   * @param {number} [options.capacity] Initial instance capacity
   */
  constructor({
    radius = 1,
    size = 0.055,
    color = 0x7ce4ff,
    capacity = DEFAULT_CAPACITY,
  } = {}) {
    this.radius = radius
    this.size = size
    this.defaultColor = new Color(color)

    /** @type {Array<{id: number, lat: number, lng: number, data: object, color: Color}>} */
    this.markers = []
    this._nextId = 1
    this._capacity = Math.max(1, capacity)

    this._matrix = new Matrix4()
    this._quaternion = new Quaternion()
    this._scale = new Vector3(1, 1, 1)
    this._position = new Vector3()

    // Scratch vectors for picking, hoisted so a click allocates nothing.
    this._projected = new Vector3()
    this._cameraPosition = new Vector3()
    this._toCamera = new Vector3()

    this.mesh = this._createMesh(this._capacity)
  }

  _createMesh(capacity) {
    // A quad rather than a sphere: the marker is a screen-facing glow, so two
    // triangles carry it. 1000 markers is then 2000 triangles total.
    const geometry = new PlaneGeometry(this.size, this.size)

    const colors = new Float32Array(capacity * 3)
    const phases = new Float32Array(capacity)
    const scales = new Float32Array(capacity)

    geometry.setAttribute('instanceColor', new InstancedBufferAttribute(colors, 3))
    geometry.setAttribute('instancePhase', new InstancedBufferAttribute(phases, 1))
    geometry.setAttribute('instanceScale', new InstancedBufferAttribute(scales, 1))

    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 instanceColor;
        attribute float instancePhase;
        attribute float instanceScale;

        uniform float uTime;

        varying vec2 vUv;
        varying vec3 vColor;
        varying float vPulse;

        void main() {
          vUv = uv;
          vColor = instanceColor;

          // Each marker breathes on its own phase offset, so a cluster reads as
          // many independent lights instead of one synchronised blink.
          vPulse = 0.75 + 0.25 * sin(uTime * 2.2 + instancePhase);

          // Billboard: take the instance translation from the matrix but drop
          // its rotation, so every quad faces the camera. Doing this in the
          // shader avoids a per-frame CPU pass over every instance matrix.
          vec3 instancePosition = vec3(
            instanceMatrix[3][0],
            instanceMatrix[3][1],
            instanceMatrix[3][2]
          );

          vec4 viewCenter = modelViewMatrix * vec4(instancePosition, 1.0);
          float scale = instanceScale * vPulse;
          vec4 viewPosition = viewCenter + vec4(position.xy * scale, 0.0, 0.0);

          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;

        varying vec2 vUv;
        varying vec3 vColor;
        varying float vPulse;

        void main() {
          // Radial falloff from the quad centre. Squaring the distance term
          // gives a tight core with a soft halo, which reads as a light source
          // rather than a flat dot.
          float dist = length(vUv - 0.5) * 2.0;
          if (dist > 1.0) discard;

          float core = pow(1.0 - dist, 3.0);
          float halo = pow(1.0 - dist, 1.2) * 0.35;
          float alpha = (core + halo) * uOpacity * vPulse;

          // The globe underneath is a field of city lights, so a marker that is
          // merely "a bright dot" disappears into it. Blowing the core out
          // towards white gives each marker a hot centre that no amount of
          // background glow matches, which is what separates figure from ground.
          vec3 tint = mix(vColor, vec3(1.0), core * 0.75);

          gl_FragColor = vec4(tint * (1.0 + core * 1.2), alpha);
        }
      `,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    })

    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.count = 0
    mesh.name = 'markers'
    mesh.frustumCulled = false
    return mesh
  }

  /**
   * Add a marker.
   *
   * @param {number} lat
   * @param {number} lng
   * @param {object} [data] Arbitrary payload handed back on click
   * @param {object} [options]
   * @param {number|string} [options.color]
   * @param {number} [options.scale] Multiplier on the base marker size
   * @returns {number} Marker id, for removal
   */
  addMarker(lat, lng, data = {}, { color, scale = 1 } = {}) {
    const id = this._nextId++
    const marker = {
      id,
      lat,
      lng,
      data,
      color: color === undefined ? this.defaultColor.clone() : new Color(color),
      scale,
      // Deterministic phase from the id: no Math.random, so a given dataset
      // always animates identically. The multiplier is close to the golden
      // angle, which keeps consecutive ids far apart in phase — neighbouring
      // markers then pulse independently instead of blinking in unison.
      phase: (id * 2.399963) % (Math.PI * 2),
    }

    this.markers.push(marker)
    if (this.markers.length > this._capacity) this._grow()
    this._writeInstance(this.markers.length - 1)
    this.mesh.count = this.markers.length
    this.mesh.instanceMatrix.needsUpdate = true
    return marker.id
  }

  /** Add many markers with a single buffer flush. */
  addMarkers(list) {
    const ids = []
    for (const item of list) {
      const { lat, lng, color, scale, ...rest } = item
      ids.push(this.addMarker(lat, lng, rest, { color, scale }))
    }
    return ids
  }

  /** @param {number} id */
  removeMarker(id) {
    const index = this.markers.findIndex((m) => m.id === id)
    if (index === -1) return false

    this.markers.splice(index, 1)
    // Rewrite from the removal point onward; instance order must stay dense.
    for (let i = index; i < this.markers.length; i++) this._writeInstance(i)
    this.mesh.count = this.markers.length
    this.mesh.instanceMatrix.needsUpdate = true
    return true
  }

  clear() {
    this.markers.length = 0
    this.mesh.count = 0
    this.mesh.instanceMatrix.needsUpdate = true
  }

  _grow() {
    const newCapacity = Math.max(this._capacity * GROWTH_FACTOR, this.markers.length)
    const old = this.mesh
    const parent = old.parent

    this._capacity = newCapacity
    this.mesh = this._createMesh(newCapacity)
    for (let i = 0; i < this.markers.length; i++) this._writeInstance(i)
    this.mesh.count = this.markers.length

    if (parent) {
      parent.remove(old)
      parent.add(this.mesh)
    }
    old.geometry.dispose()
    old.material.dispose()
  }

  _writeInstance(index) {
    const marker = this.markers[index]
    // Markers sit a hair above the surface so they are never z-fought by the
    // Earth mesh at grazing angles.
    latLngToVector3(marker.lat, marker.lng, this.radius * 1.002, this._position)

    this._matrix.compose(this._position, this._quaternion, this._scale)
    this.mesh.setMatrixAt(index, this._matrix)

    const geometry = this.mesh.geometry
    const colors = geometry.getAttribute('instanceColor')
    colors.setXYZ(index, marker.color.r, marker.color.g, marker.color.b)
    colors.needsUpdate = true

    const phases = geometry.getAttribute('instancePhase')
    phases.setX(index, marker.phase)
    phases.needsUpdate = true

    const scales = geometry.getAttribute('instanceScale')
    scales.setX(index, marker.scale)
    scales.needsUpdate = true
  }

  /**
   * Hit-test markers under a pointer event.
   *
   * Note on why this is not a plain raycast: the markers are billboarded in
   * the vertex shader, so the GPU draws each quad facing the camera while the
   * CPU-side geometry still points along its original axis. Raycasting would
   * test the wrong orientation and misfire.
   *
   * Instead we project every marker to screen space and take the nearest one
   * within a pixel threshold. That also gives finger-friendly targets for free:
   * a 3-pixel dot is unclickable on a phone, so the threshold is what makes
   * touch usable rather than an afterthought.
   *
   * Cost is O(markers) per click with no allocation, which at 1000 markers is
   * well under a millisecond — clicks are not a hot path.
   *
   * @returns {{id: number, lat: number, lng: number, data: object}|null}
   */
  pick(event, camera, domElement, { thresholdPx = 18 } = {}) {
    if (this.markers.length === 0) return null

    const rect = domElement.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top

    // Camera position in world space, used to reject markers on the far side.
    camera.getWorldPosition(this._cameraPosition)

    let best = null
    let bestDistanceSq = thresholdPx * thresholdPx

    for (const marker of this.markers) {
      latLngToVector3(marker.lat, marker.lng, this.radius * 1.002, this._position)

      // Back-face rejection: if the surface normal at the marker points away
      // from the camera, the marker is behind the globe and must not be
      // clickable even though it projects onto the same screen area.
      this._toCamera.copy(this._cameraPosition).sub(this._position)
      if (this._position.dot(this._toCamera) <= 0) continue

      this._projected.copy(this._position).project(camera)
      if (this._projected.z > 1) continue

      const screenX = (this._projected.x * 0.5 + 0.5) * rect.width
      const screenY = (-this._projected.y * 0.5 + 0.5) * rect.height

      const dx = screenX - pointerX
      const dy = screenY - pointerY
      const distanceSq = dx * dx + dy * dy

      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq
        best = marker
      }
    }

    if (!best) return null
    return { id: best.id, lat: best.lat, lng: best.lng, data: best.data }
  }

  /** Advance the pulse animation. */
  update(elapsedSeconds) {
    this.mesh.material.uniforms.uTime.value = elapsedSeconds
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.markers.length = 0
  }
}
