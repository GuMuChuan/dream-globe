import { Spherical, Vector2 } from 'three'
import { clamp, latLngToVector3 } from './coords.js'

/**
 * Orbit controller with damping and a geographic flyTo.
 *
 * Why this is hand-written instead of using OrbitControls:
 *
 *  - flyTo needs to interpolate the *camera state* (polar angle, azimuth,
 *    distance), not a look-at target. Driving OrbitControls externally while
 *    it also handles input produces fights between the two.
 *  - Keeping the state as a Spherical means the polar angle can be clamped
 *    away from the exact poles, which is what prevents the "globe flips over"
 *    jitter that plagues naive lat/lng accumulation.
 *  - No dependency on three/examples, so the library bundles cleanly for the
 *    plain <script> build.
 */

const POLE_EPSILON = 0.05 // radians kept clear of each pole
const DEFAULT_RADIUS = 3.2 // starting camera distance, also the drag-speed reference

export class GlobeControls {
  constructor(camera, domElement, {
    minDistance = 1.35,
    maxDistance = 6,
    rotateSpeed = 0.005,
    zoomSpeed = 0.0015,
    damping = 0.12,
    autoRotateSpeed = 0.00035,
  } = {}) {
    this.camera = camera
    this.domElement = domElement
    this.minDistance = minDistance
    this.maxDistance = maxDistance
    this.rotateSpeed = rotateSpeed
    this.zoomSpeed = zoomSpeed
    this.damping = damping
    this.autoRotateSpeed = autoRotateSpeed
    this.autoRotate = true

    // Current and target camera state. Input moves the target; the update
    // loop eases current towards it. This is what makes drags feel weighted
    // instead of stuck to the cursor.
    //
    // The starting radius is 3.2 rather than something tighter: at a 45 degree
    // field of view the globe's visible half-height is radius * tan(22.5),
    // so at 2.6 the sphere already touches the frame edges and the atmosphere
    // gets clipped. 3.2 leaves the silhouette a comfortable margin.
    this.spherical = new Spherical(DEFAULT_RADIUS, Math.PI / 2.2, 0)
    this.targetSpherical = this.spherical.clone()

    this._pointers = new Map()
    this._lastSingle = new Vector2()
    this._lastPinchDistance = 0
    this._flight = null
    this._disposed = false

    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)
    this._onWheel = this._onWheel.bind(this)
    this._onContextMenu = (event) => event.preventDefault()

    // Pointer move/up are tracked on the window rather than the canvas so a
    // drag that leaves the element still works. But the window is resolved
    // through the element's own document instead of the global: that keeps the
    // class usable inside an iframe or a popped-out window, and keeps merely
    // importing this module from throwing under SSR, where `window` does not
    // exist. Falling back to the element itself means a caller can pass a
    // plain object in tests and get sane behaviour rather than a crash.
    this._window = domElement.ownerDocument?.defaultView ?? domElement

    domElement.style.touchAction = 'none'
    domElement.addEventListener('pointerdown', this._onPointerDown)
    domElement.addEventListener('wheel', this._onWheel, { passive: false })
    domElement.addEventListener('contextmenu', this._onContextMenu)
    this._window.addEventListener('pointermove', this._onPointerMove)
    this._window.addEventListener('pointerup', this._onPointerUp)
    this._window.addEventListener('pointercancel', this._onPointerUp)
  }

  get isFlying() {
    return this._flight !== null
  }

  /** True while the user is actively dragging — used to suspend auto-rotate. */
  get isInteracting() {
    return this._pointers.size > 0
  }

  _onPointerDown(event) {
    this._pointers.set(event.pointerId, new Vector2(event.clientX, event.clientY))
    this._lastSingle.set(event.clientX, event.clientY)
    this._cancelFlight()
    this.autoRotate = false
  }

  _onPointerMove(event) {
    if (!this._pointers.has(event.pointerId)) return
    this._pointers.set(event.pointerId, new Vector2(event.clientX, event.clientY))

    if (this._pointers.size === 1) {
      const dx = event.clientX - this._lastSingle.x
      const dy = event.clientY - this._lastSingle.y
      this._lastSingle.set(event.clientX, event.clientY)

      // Rotate speed scales with distance so the drag feels consistent when
      // zoomed in: at close range a pixel of drag should cover less arc.
      const scale = this.rotateSpeed * (this.spherical.radius / DEFAULT_RADIUS)
      this.targetSpherical.theta -= dx * scale
      this.targetSpherical.phi = clamp(
        this.targetSpherical.phi - dy * scale,
        POLE_EPSILON,
        Math.PI - POLE_EPSILON,
      )
      return
    }

    if (this._pointers.size === 2) {
      const [a, b] = [...this._pointers.values()]
      const distance = a.distanceTo(b)
      if (this._lastPinchDistance > 0) {
        const delta = this._lastPinchDistance - distance
        this._applyZoom(delta * 4)
      }
      this._lastPinchDistance = distance
    }
  }

  _onPointerUp(event) {
    this._pointers.delete(event.pointerId)
    if (this._pointers.size < 2) this._lastPinchDistance = 0
  }

  _onWheel(event) {
    event.preventDefault()
    this._cancelFlight()
    this._applyZoom(event.deltaY)
  }

  _applyZoom(delta) {
    // Multiplicative zoom: each notch changes distance by a ratio, so the
    // step feels the same whether you are near the surface or far out.
    const factor = Math.exp(delta * this.zoomSpeed)
    this.targetSpherical.radius = clamp(
      this.targetSpherical.radius * factor,
      this.minDistance,
      this.maxDistance,
    )
  }

  /**
   * Animate the camera to sit above a geographic coordinate.
   *
   * The azimuth is unwrapped to the nearest equivalent angle before easing,
   * which is what stops a flight from London to Tokyo taking the long way
   * around the globe when the raw difference exceeds pi.
   *
   * @param {number} lat
   * @param {number} lng
   * @param {object} [options]
   * @param {number} [options.distance] Final camera distance from centre
   * @param {number} [options.duration] Milliseconds
   * @returns {Promise<void>} Resolves when the flight finishes or is cancelled
   */
  flyTo(lat, lng, { distance, duration = 1600 } = {}) {
    const surface = latLngToVector3(lat, lng, 1)
    const destination = new Spherical().setFromVector3(surface)

    const targetRadius = clamp(
      distance ?? Math.max(this.minDistance, this.spherical.radius * 0.72),
      this.minDistance,
      this.maxDistance,
    )

    // Unwrap: choose the representation of the destination azimuth closest to
    // where we currently are.
    let theta = destination.theta
    const current = this.spherical.theta
    while (theta - current > Math.PI) theta -= Math.PI * 2
    while (theta - current < -Math.PI) theta += Math.PI * 2

    this.autoRotate = false

    // Settle any flight already in progress before replacing it. Overwriting
    // this._flight would drop the previous promise's resolve on the floor, and
    // a caller sitting on `await globe.flyTo(...)` would hang forever the
    // moment a second flyTo — or a drag — cut the first one short.
    this._cancelFlight()

    return new Promise((resolve) => {
      this._flight = {
        from: this.spherical.clone(),
        to: new Spherical(
          targetRadius,
          clamp(destination.phi, POLE_EPSILON, Math.PI - POLE_EPSILON),
          theta,
        ),
        elapsed: 0,
        duration: Math.max(1, duration),
        resolve,
      }
    })
  }

  _cancelFlight() {
    if (!this._flight) return
    const { resolve } = this._flight
    this._flight = null
    resolve()
  }

  /**
   * Jump any in-flight animation straight to its destination.
   *
   * Used before a screenshot, and useful to a caller who wants flyTo's final
   * camera state without waiting out the easing.
   *
   * @returns {boolean} true if a flight was actually skipped
   */
  finishFlight() {
    if (!this._flight) return false
    this.update(this._flight.duration - this._flight.elapsed)
    return true
  }

  /**
   * Advance the controller. Must be called once per frame with the frame
   * delta in milliseconds.
   */
  update(deltaMs) {
    if (this._flight) {
      const flight = this._flight
      flight.elapsed += deltaMs
      const t = Math.min(1, flight.elapsed / flight.duration)
      const eased = easeInOutCubic(t)

      this.spherical.radius = lerp(flight.from.radius, flight.to.radius, eased)
      this.spherical.phi = lerp(flight.from.phi, flight.to.phi, eased)
      this.spherical.theta = lerp(flight.from.theta, flight.to.theta, eased)
      this.targetSpherical.copy(this.spherical)

      if (t >= 1) this._cancelFlight()
    } else {
      if (this.autoRotate && !this.isInteracting) {
        this.targetSpherical.theta += this.autoRotateSpeed * deltaMs
      }

      // Frame-rate independent damping. A plain `current += (target-current)*k`
      // eases faster on a 144 Hz display than on a 60 Hz one; the exponential
      // form keeps the settle time identical on both.
      const alpha = 1 - Math.exp(-this.damping * (deltaMs / 16.667))
      this.spherical.radius = lerp(this.spherical.radius, this.targetSpherical.radius, alpha)
      this.spherical.phi = lerp(this.spherical.phi, this.targetSpherical.phi, alpha)
      this.spherical.theta = lerp(this.spherical.theta, this.targetSpherical.theta, alpha)
    }

    this.spherical.makeSafe()
    this.camera.position.setFromSpherical(this.spherical)
    this.camera.lookAt(0, 0, 0)
  }

  /** Current camera distance from the globe centre, for LOD decisions. */
  get distance() {
    return this.spherical.radius
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    this._cancelFlight()
    this.domElement.removeEventListener('pointerdown', this._onPointerDown)
    this.domElement.removeEventListener('wheel', this._onWheel)
    this.domElement.removeEventListener('contextmenu', this._onContextMenu)
    this._window.removeEventListener('pointermove', this._onPointerMove)
    this._window.removeEventListener('pointerup', this._onPointerUp)
    this._window.removeEventListener('pointercancel', this._onPointerUp)
    this._pointers.clear()
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
