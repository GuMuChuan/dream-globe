import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
} from 'three'

/**
 * Texture sourcing for the globe.
 *
 * Two things matter here beyond "load a jpg":
 *
 * 1. The globe must render something on the very first frame. A full
 *    night-lights texture is several megabytes; waiting for it means the
 *    user stares at a black canvas and assumes the page is broken. We paint
 *    a procedural placeholder immediately and swap in the real texture when
 *    it arrives.
 *
 * 2. Loading can fail — offline, blocked CDN, wrong path after deployment.
 *    A failure must degrade to the placeholder, never to a blank screen.
 */

/**
 * Resolution ladder. Mobile GPUs commonly cap at 4096, and a 8k texture on a
 * mid-range phone costs ~180 MB of VRAM once mipmapped — enough to get the
 * tab killed. Pick by viewport width, not by user agent sniffing.
 */
export function pickTextureSize(viewportWidth = 1280) {
  if (viewportWidth <= 480) return 2048
  if (viewportWidth <= 1024) return 4096
  return 8192
}

/**
 * Build a procedural stand-in for the night-Earth texture.
 *
 * This is deliberately not a photo: it is generated from a seeded PRNG so it
 * is identical on every run and in every environment, which keeps the first
 * frame reproducible and keeps the repository free of large binary assets.
 *
 * It reads as "dark ocean with clustered city lights" from a distance, which
 * is enough to confirm the globe, rotation and markers all work before the
 * real imagery lands.
 */
export function createPlaceholderTexture({ width = 2048, height = 1024, seed = 20260730 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  // Deep ocean base with a subtle latitude gradient, brighter near the equator.
  //
  // These values are near-black on purpose. City lights are the only thing this
  // texture exists to show, and they only read as *lights* if everything around
  // them is dark. An ocean at #061024 measured a mean of (19, 31, 53) at the
  // centre of the disc — bright enough that the whole globe looked fogged and
  // the clusters lost their punch. Lowering the ambient light instead dimmed
  // the cities by the same factor and fixed nothing; the black point has to
  // come down in the source art.
  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, '#010206')
  gradient.addColorStop(0.5, '#020610')
  gradient.addColorStop(1, '#010206')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  const random = mulberry32(seed)

  /**
   * Draw a callback at x, and again shifted a full width to either side when
   * it falls near a seam.
   *
   * An equirectangular texture wraps: u=0 and u=1 are the same meridian. A
   * blob painted at x=5 with radius 80 should bleed round to the right-hand
   * edge, but a plain fill just clips it. The result is a hard vertical seam
   * running pole to pole, which on a rotating globe is the most obvious
   * artefact there is.
   */
  function drawWrapped(x, radius, draw) {
    draw(x)
    if (x - radius < 0) draw(x + width)
    if (x + radius > width) draw(x - width)
  }

  // Landmass-ish blobs so the placeholder is not a featureless void.
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < 90; i++) {
    const cx = random() * width
    // Bias landmasses towards temperate latitudes, as on the real Earth.
    const cy = height * (0.2 + random() * 0.6)
    const radius = (0.02 + random() * 0.07) * width

    drawWrapped(cx, radius, (x) => {
      const blob = ctx.createRadialGradient(x, cy, 0, x, cy, radius)
      // Landmasses are hinted, not drawn. Anything brighter competes with the
      // city clusters that sit on top of them.
      blob.addColorStop(0, 'rgba(14, 24, 38, 0.42)')
      blob.addColorStop(1, 'rgba(4, 9, 18, 0)')
      ctx.fillStyle = blob
      ctx.beginPath()
      ctx.arc(x, cy, radius, 0, Math.PI * 2)
      ctx.fill()
    })
  }

  // City lights: dense clusters plus scattered singles, warm white to amber.
  for (let cluster = 0; cluster < 140; cluster++) {
    const cx = random() * width
    const cy = height * (0.15 + random() * 0.7)
    const spread = (0.004 + random() * 0.03) * width
    const count = 8 + Math.floor(random() * 70)

    // Pre-generate the cluster so every wrapped copy is identical. Calling the
    // PRNG inside the wrap callback would give the two halves different dots
    // and the seam would still be visible, just noisier.
    const dots = []
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2
      // sqrt keeps points from bunching in the cluster centre.
      const distance = Math.sqrt(random()) * spread
      dots.push({
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance * 0.7,
        size: 0.6 + random() * 1.6,
        warmth: 170 + Math.floor(random() * 70),
        alpha: 0.25 + random() * 0.6,
      })
    }

    drawWrapped(cx, spread, (x) => {
      for (const dot of dots) {
        ctx.fillStyle = `rgba(255, ${dot.warmth + 20}, ${dot.warmth - 40}, ${dot.alpha})`
        ctx.beginPath()
        ctx.arc(x + dot.dx, cy + dot.dy, dot.size, 0, Math.PI * 2)
        ctx.fill()
      }
    })
  }
  ctx.globalCompositeOperation = 'source-over'

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  // Longitude wraps; latitude does not. Clamping u would make the filter blend
  // the last texel against the edge instead of against the first texel, which
  // leaves a faint seam even once the content itself wraps correctly.
  texture.wrapS = RepeatWrapping
  texture.wrapT = ClampToEdgeWrapping
  return texture
}

/**
 * Load the real night-lights texture, resolving to null instead of throwing
 * so the caller can simply keep the placeholder.
 *
 * @param {string} url
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<import('three').Texture|null>}
 */
export function loadNightTexture(url, onProgress) {
  if (!url) return Promise.resolve(null)

  return new Promise((resolve) => {
    new TextureLoader().load(
      url,
      (texture) => {
        texture.colorSpace = SRGBColorSpace
        // Same wrapping rule as the placeholder: an equirectangular photo has
        // the same seam problem, and clamping u leaves a visible line down the
        // dateline once the globe rotates past it.
        texture.wrapS = RepeatWrapping
        texture.wrapT = ClampToEdgeWrapping
        // Anisotropy is set by the renderer-aware caller; default filtering
        // is fine because the globe is never viewed at a grazing angle.
        resolve(texture)
      },
      (event) => {
        if (onProgress && event.lengthComputable) {
          onProgress(event.loaded / event.total)
        }
      },
      () => {
        // Swallow the error deliberately: the globe stays usable on the
        // placeholder, and a console warning is enough signal for a developer.
        console.warn(`[dream-globe] night texture failed to load: ${url}`)
        resolve(null)
      },
    )
  })
}

/**
 * Small deterministic PRNG (mulberry32). Used instead of Math.random so the
 * placeholder is byte-identical across runs, machines and CI.
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
