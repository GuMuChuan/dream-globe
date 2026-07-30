import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineSegments,
  ShaderMaterial,
} from 'three'
import { angularDistance, greatCircleArc } from './coords.js'

/**
 * Great-circle connection arcs.
 *
 * Same constraint as the marker layer: a Line per connection is a draw call
 * per connection, and a flight-route map wants hundreds. So every arc is
 * baked into one merged LineSegments geometry and drawn in a single call.
 *
 * The cost of merging is that adding an arc rebuilds the buffer. That is the
 * right trade here — arcs are set up once from a dataset and then animate on
 * the GPU, whereas markers get added and removed interactively.
 *
 * Segment counts scale with arc length. A 200 km hop and a transpacific route
 * both look wrong at a fixed count: the short one wastes vertices, the long
 * one visibly facets.
 */

const MIN_SEGMENTS = 16
const MAX_SEGMENTS = 128

/**
 * Hard ceiling on how far an arc may rise above the surface, as a fraction of
 * the globe radius.
 *
 * Two limits meet here. GlobeControls lets the camera come in to 1.35 radii,
 * so anything peaking above that passes through the viewer when zoomed all the
 * way in. But the tighter constraint is visual: at 0.28 the long routes stand
 * so far off the limb that, on a globe carrying a dozen of them, their peaks
 * line up into what reads as a drawn ring around the planet. 0.16 keeps a
 * transpacific arc clearly airborne while holding it against the disc.
 */
const MAX_LIFT = 0.16

export class ArcLayer {
  /**
   * @param {object} [options]
   * @param {number} [options.radius] Globe radius the arcs spring from
   * @param {number|string} [options.color] Default arc colour
   * @param {number} [options.liftScale] Peak height as a fraction of radius
   * @param {number} [options.speed] Pulse travel speed, cycles per second
   */
  constructor({
    radius = 1,
    color = 0x7ce4ff,
    liftScale = 0.5,
    speed = 0.45,
  } = {}) {
    this.radius = radius
    this.defaultColor = new Color(color)
    // Clamped so a caller cannot push arcs through the camera's near limit.
    this.liftScale = Math.min(liftScale, MAX_LIFT)

    /** @type {Array<{id: number, from: [number, number], to: [number, number], color: Color, offset: number}>} */
    this.arcs = []
    this._nextId = 1
    this._dirty = false

    this.material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: speed },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aProgress;
        attribute vec3 aColor;
        attribute float aOffset;

        varying float vProgress;
        varying vec3 vColor;
        varying float vOffset;

        void main() {
          vProgress = aProgress;
          vColor = aColor;
          vOffset = aOffset;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uSpeed;
        uniform float uOpacity;

        varying float vProgress;
        varying vec3 vColor;
        varying float vOffset;

        void main() {
          // A comet head travelling from origin to destination. fract() makes
          // it loop; the per-arc offset stops every route on the map from
          // firing in lockstep, which is the thing that makes these maps read
          // as fake.
          float head = fract(uTime * uSpeed + vOffset);

          // Distance from this vertex to the head, wrapped so the pulse can
          // cross the seam without a visible jump.
          float d = vProgress - head;
          d = d - floor(d + 0.5);

          // Tail trails behind the head only: a symmetric falloff looks like a
          // glowing bead, an asymmetric one looks like motion.
          float tail = d < 0.0 ? exp(d * 9.0) : exp(-d * 42.0);

          // The faint always-on line keeps the route readable between pulses,
          // so the map still communicates its connections when paused. It has
          // to carry real weight: WebGL ignores gl_LineWidth on almost every
          // platform, so brightness is the only lever for making a 1 px line
          // legible over a field of city lights.
          float base = 0.62;
          float alpha = (base + tail * 1.1) * uOpacity;

          // Fade both ends so arcs emerge from the surface instead of being
          // clipped flat against it.
          float ends = smoothstep(0.0, 0.06, vProgress) * smoothstep(1.0, 0.94, vProgress);
          alpha *= ends;

          // Push the colour past 1.0 so the additive blend saturates towards
          // white at the core of the line. A 1 px line cannot be made thicker,
          // but it can be made to bloom.
          gl_FragColor = vec4(vColor * (1.35 + tail * 1.8), alpha);
        }
      `,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    })

    this.geometry = new BufferGeometry()
    this.mesh = new LineSegments(this.geometry, this.material)
    this.mesh.name = 'arcs'
    this.mesh.frustumCulled = false
  }

  /**
   * Connect two coordinates.
   *
   * @param {[number, number]} from [lat, lng]
   * @param {[number, number]} to [lat, lng]
   * @param {object} [options]
   * @param {number|string} [options.color]
   * @returns {number} Arc id, for removal
   */
  addArc(from, to, { color } = {}) {
    const id = this._nextId++
    this.arcs.push({
      id,
      from,
      to,
      color: color === undefined ? this.defaultColor.clone() : new Color(color),
      // Deterministic phase offset from the id, so a given dataset always
      // animates identically — no Math.random anywhere in this library.
      offset: (id * 0.381966) % 1,
    })
    this._dirty = true
    return id
  }

  /** @param {Array<{from: [number, number], to: [number, number], color?: number|string}>} list */
  addArcs(list) {
    return list.map((item) => this.addArc(item.from, item.to, { color: item.color }))
  }

  /** @param {number} id */
  removeArc(id) {
    const index = this.arcs.findIndex((a) => a.id === id)
    if (index === -1) return false
    this.arcs.splice(index, 1)
    this._dirty = true
    return true
  }

  clear() {
    this.arcs.length = 0
    this._dirty = true
  }

  /**
   * Rebuild the merged geometry. Called lazily from update() so a batch of
   * addArc calls costs one rebuild rather than one each.
   */
  _rebuild() {
    this._dirty = false

    if (this.arcs.length === 0) {
      this.geometry.setDrawRange(0, 0)
      return
    }

    // First pass: work out the total vertex count so the typed arrays can be
    // allocated once instead of growing.
    const plans = this.arcs.map((arc) => {
      const omega = angularDistance(arc.from[0], arc.from[1], arc.to[0], arc.to[1])
      const segments = Math.round(
        MIN_SEGMENTS + (MAX_SEGMENTS - MIN_SEGMENTS) * Math.min(1, omega / Math.PI),
      )
      return { arc, segments }
    })

    // LineSegments consumes vertices in pairs, so an n-segment arc needs
    // 2n vertices: each interior point is written twice, once as the end of
    // one segment and once as the start of the next.
    const vertexCount = plans.reduce((sum, p) => sum + p.segments * 2, 0)

    const positions = new Float32Array(vertexCount * 3)
    const progress = new Float32Array(vertexCount)
    const colors = new Float32Array(vertexCount * 3)
    const offsets = new Float32Array(vertexCount)

    let v = 0
    for (const { arc, segments } of plans) {
      const points = greatCircleArc(arc.from[0], arc.from[1], arc.to[0], arc.to[1], {
        radius: this.radius,
        segments,
        liftScale: this.liftScale,
      })

      for (let i = 0; i < segments; i++) {
        for (const [point, t] of [
          [points[i], i / segments],
          [points[i + 1], (i + 1) / segments],
        ]) {
          positions[v * 3] = point.x
          positions[v * 3 + 1] = point.y
          positions[v * 3 + 2] = point.z
          progress[v] = t
          colors[v * 3] = arc.color.r
          colors[v * 3 + 1] = arc.color.g
          colors[v * 3 + 2] = arc.color.b
          offsets[v] = arc.offset
          v++
        }
      }
    }

    this.geometry.setAttribute('position', new BufferAttribute(positions, 3))
    this.geometry.setAttribute('aProgress', new BufferAttribute(progress, 1))
    this.geometry.setAttribute('aColor', new BufferAttribute(colors, 3))
    this.geometry.setAttribute('aOffset', new BufferAttribute(offsets, 1))
    this.geometry.setDrawRange(0, vertexCount)
  }

  /** Vertices currently uploaded, for the stats readout. */
  get vertexCount() {
    return this.geometry.getAttribute('position')?.count ?? 0
  }

  /** Advance the pulse. Rebuilds the buffer first if arcs changed. */
  update(elapsedSeconds) {
    if (this._dirty) this._rebuild()
    this.material.uniforms.uTime.value = elapsedSeconds
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
    this.arcs.length = 0
  }
}
