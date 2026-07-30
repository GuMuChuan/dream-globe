import {
  AmbientLight,
  Clock,
  Group,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three'
import { GLOBE_RADIUS, createAtmosphere, createEarth } from './core/earth.js'
import { GlobeControls } from './core/controls.js'
import { MarkerLayer } from './core/markers.js'
import { ArcLayer } from './core/arcs.js'
import { createPlaceholderTexture, loadNightTexture, pickTextureSize } from './core/textures.js'

/**
 * DreamGlobe — an interactive night-lights globe.
 *
 * Public surface is deliberately small: construct with a container element,
 * push markers in, listen for clicks. Everything else (render loop, resize,
 * texture streaming, disposal) is handled internally, because the integration
 * cost is what decides whether a widget like this actually ships.
 *
 *   const globe = new DreamGlobe(document.querySelector('#globe'))
 *   globe.addMarkers([{ lat: 51.5, lng: -0.12, title: 'London' }])
 *   globe.on('markerclick', (m) => console.log(m.data.title))
 */
export class DreamGlobe {
  /**
   * @param {HTMLElement} container
   * @param {object} [options]
   * @param {string} [options.textureUrl] Night-lights equirectangular image
   * @param {boolean} [options.autoRotate]
   * @param {number} [options.markerColor]
   * @param {number} [options.arcColor]
   * @param {number} [options.maxPixelRatio] Caps DPR; 2 is plenty on phones
   */
  constructor(container, {
    textureUrl,
    autoRotate = true,
    markerColor = 0x7ce4ff,
    arcColor = 0x7ce4ff,
    maxPixelRatio = 2,
  } = {}) {
    if (!container) throw new Error('DreamGlobe: container element is required')

    this.container = container
    this.maxPixelRatio = maxPixelRatio
    // Resolved from the container rather than the global so the widget works
    // inside an iframe or a popped-out window, where the global `window` is
    // not the one that owns this element.
    this._window = container.ownerDocument?.defaultView ?? globalThis
    this._document = container.ownerDocument ?? globalThis.document
    this._listeners = new Map()
    this._disposed = false
    this._clock = new Clock()

    this.scene = new Scene()
    this.camera = new PerspectiveCamera(45, 1, 0.1, 100)

    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      // Explicitly ask for the discrete GPU on laptops that have two.
      powerPreference: 'high-performance',
    })
    this.renderer.setClearColor(0x000000, 0)
    container.appendChild(this.renderer.domElement)

    // The night texture is emissive-looking already, so the light rig only has
    // to keep the material from rendering black. A single ambient light is
    // cheaper than any directional setup and looks identical here.
    this.scene.add(new AmbientLight(0xffffff, 1.6))

    this.globeGroup = new Group()
    this.scene.add(this.globeGroup)

    // Start on a procedural placeholder so the globe is interactive within a
    // frame or two, then swap in the real imagery when it arrives. A 8K JPEG
    // is several megabytes; blocking first paint on it is what makes these
    // widgets feel broken on mobile connections.
    //
    // The placeholder is sized off the viewport too. On a 360 px phone a
    // 2048-wide canvas is already more detail than the screen can resolve, and
    // generating one costs main-thread time during first paint — the exact
    // moment the page is trying to become interactive.
    //
    // This is a separate ladder from pickTextureSize: that one sizes the real
    // photographic imagery, where detail is the point. The placeholder only
    // has to read as "dark ocean with city lights" until the real texture
    // lands, so it can be far smaller.
    const width = container.clientWidth || 1280
    const placeholderWidth = width <= 600 ? 1024 : width <= 1024 ? 1536 : 2048
    this._placeholder = createPlaceholderTexture({
      width: placeholderWidth,
      height: placeholderWidth / 2,
    })
    // Sphere tessellation scales with the viewport. At 96 segments the globe
    // is perfectly smooth on a desktop monitor; on a 360 px phone the same
    // mesh spends triangles on curvature finer than a single pixel.
    const segments = (container.clientWidth || 1280) <= 600 ? 48 : 96
    this.earth = createEarth({
      texture: this._placeholder,
      radius: GLOBE_RADIUS,
      segments,
    })
    this.atmosphere = createAtmosphere({ radius: GLOBE_RADIUS })
    this.globeGroup.add(this.earth, this.atmosphere)

    this.markerLayer = new MarkerLayer({ radius: GLOBE_RADIUS, color: markerColor })
    this.globeGroup.add(this.markerLayer.mesh)

    this.arcLayer = new ArcLayer({ radius: GLOBE_RADIUS, color: arcColor })
    this.globeGroup.add(this.arcLayer.mesh)

    this.controls = new GlobeControls(this.camera, this.renderer.domElement)
    this.controls.autoRotate = autoRotate

    this._onResize = this._onResize.bind(this)
    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)
    this._tick = this._tick.bind(this)

    this._resizeObserver = new this._window.ResizeObserver(this._onResize)
    this._resizeObserver.observe(container)
    this._onResize()

    // Distinguish a click from a drag: a globe is dragged constantly, and
    // firing markerclick at the end of every drag would be maddening.
    this._pointerDownAt = null
    this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown)
    this.renderer.domElement.addEventListener('pointerup', this._onPointerUp)

    if (textureUrl) this.setTexture(textureUrl)

    // Place the camera before the first animation frame runs. A PerspectiveCamera
    // starts at the origin — inside the globe — and requestAnimationFrame does
    // not fire in a background tab, so anything that reads the camera before
    // then (captureFrame, pick, a caller's own render) would otherwise see a
    // camera at the centre of the Earth and produce an empty frame.
    this.controls.update(0)

    this._frameHandle = requestAnimationFrame(this._tick)
  }

  /**
   * Stream in the real night-lights imagery.
   * Resolves to false if the load failed — the placeholder simply stays.
   *
   * @param {string} url
   * @param {(progress: number) => void} [onProgress]
   * @returns {Promise<boolean>}
   */
  async setTexture(url, onProgress) {
    const texture = await loadNightTexture(url, onProgress)
    if (!texture || this._disposed) return false

    // Anisotropic filtering only matters where the surface is seen at a
    // grazing angle, which on a globe is the entire limb — the place the eye
    // goes first. Capped at 8: beyond that the cost rises and the difference
    // stops being visible.
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy()
    texture.anisotropy = Math.min(8, maxAnisotropy)

    const previous = this.earth.material.map
    this.earth.material.map = texture
    this.earth.material.color.setHex(0xffffff)
    this.earth.material.needsUpdate = true
    if (previous && previous !== texture) previous.dispose()
    this._placeholder = null

    this.emit('textureload', { url })
    return true
  }

  /** Recommended texture width for the current viewport. */
  get suggestedTextureSize() {
    return pickTextureSize(this.container.clientWidth || this._window.innerWidth)
  }

  /** @returns {number} marker id */
  addMarker(lat, lng, data, options) {
    return this.markerLayer.addMarker(lat, lng, data, options)
  }

  /** @returns {number[]} marker ids */
  addMarkers(list) {
    return this.markerLayer.addMarkers(list)
  }

  removeMarker(id) {
    return this.markerLayer.removeMarker(id)
  }

  clearMarkers() {
    this.markerLayer.clear()
  }

  /**
   * Draw a great-circle arc between two coordinates.
   *
   * @param {[number, number]} from [lat, lng]
   * @param {[number, number]} to [lat, lng]
   * @param {object} [options]
   * @param {number|string} [options.color]
   * @returns {number} arc id
   */
  addArc(from, to, options) {
    return this.arcLayer.addArc(from, to, options)
  }

  /** @returns {number[]} arc ids */
  addArcs(list) {
    return this.arcLayer.addArcs(list)
  }

  removeArc(id) {
    return this.arcLayer.removeArc(id)
  }

  clearArcs() {
    this.arcLayer.clear()
  }

  /**
   * Fly the camera to a coordinate.
   * @returns {Promise<void>} resolves when the flight lands or is interrupted
   */
  flyTo(lat, lng, options) {
    return this.controls.flyTo(lat, lng, options)
  }

  set autoRotate(value) {
    this.controls.autoRotate = value
  }

  get autoRotate() {
    return this.controls.autoRotate
  }

  /**
   * @param {'markerclick'|'textureload'} event
   * @param {Function} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(handler)
    return () => this.off(event, handler)
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler)
  }

  emit(event, payload) {
    const handlers = this._listeners.get(event)
    if (!handlers) return
    for (const handler of handlers) handler(payload)
  }

  _onPointerDown(event) {
    this._pointerDownAt = { x: event.clientX, y: event.clientY }
  }

  _onPointerUp(event) {
    const start = this._pointerDownAt
    this._pointerDownAt = null
    if (!start) return

    // 6 px of slop: fingers wobble, and a tap that moved 3 px is still a tap.
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    if (moved > 6) return

    const hit = this.markerLayer.pick(event, this.camera, this.renderer.domElement)
    if (hit) this.emit('markerclick', hit)
  }

  _onResize() {
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()

    // Capping DPR is the single biggest mobile win here: a phone at DPR 3
    // renders nine times the pixels of DPR 1 for a difference nobody can see
    // on a glowing sphere.
    this.renderer.setPixelRatio(Math.min(this._window.devicePixelRatio || 1, this.maxPixelRatio))
    // updateStyle must stay on. With it off the canvas keeps no CSS size and
    // the browser lays it out at its backing-buffer size, so on any DPR above
    // 1 the canvas overflows its container and the globe gets cropped.
    this.renderer.setSize(width, height)

    // The atmosphere's falloff is measured in isotropic screen space, so it
    // needs the viewport shape. Without this the rim thickens on portrait
    // viewports and reads as a solid blue band instead of a haze.
    const atmosphereUniforms = this.atmosphere?.material?.uniforms
    if (atmosphereUniforms?.uResolution) {
      atmosphereUniforms.uResolution.value.set(width, height)
    }
  }

  _tick() {
    if (this._disposed) return
    this._frameHandle = requestAnimationFrame(this._tick)

    const delta = this._clock.getDelta()
    // Guard against the huge delta produced when a background tab wakes up,
    // which would otherwise teleport the camera on the first frame back.
    const deltaMs = Math.min(delta * 1000, 100)

    this.controls.update(deltaMs)
    this.markerLayer.update(this._clock.elapsedTime)
    this.arcLayer.update(this._clock.elapsedTime)
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Render one frame and return it as a data URL.
   *
   * WebGL clears the drawing buffer after every composite unless the context
   * was created with preserveDrawingBuffer, which carries a real cost on
   * mobile GPUs and is not worth paying on every frame just in case someone
   * wants a screenshot. So instead we render on demand and read the buffer
   * back inside the same tick, before the browser gets a chance to clear it.
   *
   * The canvas is transparent by design so the globe can sit over a page
   * background, but an exported image almost never wants that: dropped into a
   * document or a chat window it lands on white and the night-side Earth
   * vanishes. So capture composites onto an opaque colour unless asked not to.
   *
   * @param {object} [options]
   * @param {string|null} [options.background] CSS colour, or null to keep alpha
   * @param {string} [options.type] MIME type, e.g. 'image/png' or 'image/jpeg'
   * @param {number} [options.quality] 0..1, only meaningful for lossy types
   * @param {boolean} [options.settle] Finish any in-flight camera animation first
   * @returns {string} data URL
   */
  captureFrame({ background = '#04060d', type = 'image/png', quality, settle = true } = {}) {
    // Capturing mid-flight yields a frame the caller did not ask for — they
    // wanted the destination, not a blurred waypoint. Fast-forwarding the
    // animation is cheap and almost always the intent.
    if (settle) this.controls.finishFlight()

    // Flush any pending layer work before drawing. Both layers rebuild lazily
    // inside _tick, which only runs from requestAnimationFrame — and rAF does
    // not fire in a background tab. Calling renderer.render directly would
    // otherwise capture a frame with arcs added but never built: geometry with
    // zero vertices, silently missing from the image.
    this.markerLayer.update(this._clock.elapsedTime)
    this.arcLayer.update(this._clock.elapsedTime)

    this.renderer.render(this.scene, this.camera)
    const source = this.renderer.domElement

    if (background === null) return source.toDataURL(type, quality)

    const canvas = this._document.createElement('canvas')
    canvas.width = source.width
    canvas.height = source.height
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(source, 0, 0)
    return canvas.toDataURL(type, quality)
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true

    cancelAnimationFrame(this._frameHandle)
    this._resizeObserver.disconnect()
    this.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown)
    this.renderer.domElement.removeEventListener('pointerup', this._onPointerUp)

    this.controls.dispose()
    this.markerLayer.dispose()
    this.arcLayer.dispose()
    this.earth.geometry.dispose()
    this.earth.material.map?.dispose()
    this.earth.material.dispose()
    this.atmosphere.geometry.dispose()
    this.atmosphere.material.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this._listeners.clear()
  }
}

export { GLOBE_RADIUS } from './core/earth.js'
export { latLngToVector3, vector3ToLatLng, angularDistance, greatCircleArc } from './core/coords.js'
export { MarkerLayer } from './core/markers.js'
export { ArcLayer } from './core/arcs.js'
export { GlobeControls } from './core/controls.js'
