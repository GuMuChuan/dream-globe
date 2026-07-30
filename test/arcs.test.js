import { describe, it, expect } from 'vitest'
import { ArcLayer } from '../src/core/arcs.js'
import { angularDistance } from '../src/core/coords.js'

const LONDON = [51.5074, -0.1278]
const TOKYO = [35.6762, 139.6503]
const PARIS = [48.8566, 2.3522]

/** Force the lazy rebuild that update() would normally trigger. */
function build(layer) {
  layer.update(0)
  return layer
}

describe('ArcLayer geometry', () => {
  it('produces an even vertex count so LineSegments pairs up cleanly', () => {
    const layer = build(new ArcLayer())
    layer.addArc(LONDON, TOKYO)
    build(layer)

    expect(layer.vertexCount).toBeGreaterThan(0)
    expect(layer.vertexCount % 2).toBe(0)

    layer.dispose()
  })

  it('gives a long haul more segments than a short hop', () => {
    const shortLayer = build(new ArcLayer())
    shortLayer.addArc(LONDON, PARIS)
    build(shortLayer)

    const longLayer = build(new ArcLayer())
    longLayer.addArc(LONDON, TOKYO)
    build(longLayer)

    // London to Paris is ~340 km; London to Tokyo is ~9600 km. A fixed segment
    // count would either facet the long one or waste vertices on the short one.
    expect(angularDistance(...LONDON, ...PARIS))
      .toBeLessThan(angularDistance(...LONDON, ...TOKYO))
    expect(shortLayer.vertexCount).toBeLessThan(longLayer.vertexCount)

    shortLayer.dispose()
    longLayer.dispose()
  })

  it('keeps every vertex on or above the globe surface', () => {
    const layer = build(new ArcLayer({ radius: 1 }))
    layer.addArc(LONDON, TOKYO)
    build(layer)

    const positions = layer.geometry.getAttribute('position')
    let minRadius = Infinity
    let maxRadius = 0

    for (let i = 0; i < positions.count; i++) {
      const r = Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i))
      minRadius = Math.min(minRadius, r)
      maxRadius = Math.max(maxRadius, r)
    }

    // An arc that dips below the surface would be hidden inside the Earth.
    expect(minRadius).toBeGreaterThanOrEqual(1 - 1e-6)
    // And one that soars too high stops reading as a connection.
    expect(maxRadius).toBeLessThan(1.4)

    layer.dispose()
  })

  it('bounds the peak height even for the longest possible arc', () => {
    // The worst case is an antipodal pair, where the lift term is at its
    // maximum. If that clears the camera's near plane or the max zoom
    // distance the arc gets clipped, so the ceiling has to hold here too.
    const layer = build(new ArcLayer({ radius: 1 }))
    layer.addArc([0, 0], [0, 180])
    build(layer)

    const positions = layer.geometry.getAttribute('position')
    let maxRadius = 0
    for (let i = 0; i < positions.count; i++) {
      maxRadius = Math.max(
        maxRadius,
        Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i)),
      )
    }

    // Camera minDistance is 1.35, so anything at or above that would let an
    // arc pass through the viewer when zoomed all the way in.
    expect(maxRadius).toBeLessThan(1.35)

    layer.dispose()
  })

  it('starts and ends the progress attribute at 0 and 1', () => {
    const layer = build(new ArcLayer())
    layer.addArc(LONDON, TOKYO)
    build(layer)

    const progress = layer.geometry.getAttribute('aProgress')
    expect(progress.getX(0)).toBeCloseTo(0, 6)
    expect(progress.getX(progress.count - 1)).toBeCloseTo(1, 6)

    layer.dispose()
  })

  it('scales the vertex buffer with the number of arcs', () => {
    const one = build(new ArcLayer())
    one.addArc(LONDON, TOKYO)
    build(one)
    const singleCount = one.vertexCount

    const three = build(new ArcLayer())
    three.addArc(LONDON, TOKYO)
    three.addArc(LONDON, TOKYO)
    three.addArc(LONDON, TOKYO)
    build(three)

    expect(three.vertexCount).toBe(singleCount * 3)

    one.dispose()
    three.dispose()
  })

  it('handles identical endpoints without producing NaN', () => {
    const layer = build(new ArcLayer())
    layer.addArc(LONDON, LONDON)
    build(layer)

    const positions = layer.geometry.getAttribute('position')
    for (let i = 0; i < positions.array.length; i++) {
      expect(Number.isFinite(positions.array[i])).toBe(true)
    }

    layer.dispose()
  })

  it('handles antipodal endpoints without producing NaN', () => {
    const layer = build(new ArcLayer())
    layer.addArc([0, 0], [0, 180])
    build(layer)

    const positions = layer.geometry.getAttribute('position')
    for (let i = 0; i < positions.array.length; i++) {
      expect(Number.isFinite(positions.array[i])).toBe(true)
    }

    layer.dispose()
  })
})

describe('ArcLayer material', () => {
  /**
   * These flags are the whole occlusion story, and they are easy to break by
   * accident when tweaking the glow. Verified against a rendered frame: an arc
   * placed entirely on the far side of the globe changes zero pixels out of
   * 810,000, so the combination below genuinely hides it.
   */
  it('is depth-tested so the globe hides far-side arcs', () => {
    const layer = new ArcLayer()
    expect(layer.material.depthTest).toBe(true)
    layer.dispose()
  })

  it('does not write depth, so arcs never occlude each other', () => {
    // Additive blending plus depth writes produces order-dependent dropouts
    // where one arc punches a hole in another.
    const layer = new ArcLayer()
    expect(layer.material.depthWrite).toBe(false)
    expect(layer.material.transparent).toBe(true)
    layer.dispose()
  })
})

describe('ArcLayer bookkeeping', () => {
  it('rebuilds only once for a batch of additions', () => {
    const layer = new ArcLayer()
    let rebuilds = 0
    const original = layer._rebuild.bind(layer)
    layer._rebuild = () => { rebuilds++; original() }

    layer.addArc(LONDON, TOKYO)
    layer.addArc(LONDON, PARIS)
    layer.addArc(PARIS, TOKYO)
    expect(rebuilds).toBe(0) // nothing rebuilt until a frame runs

    layer.update(0)
    expect(rebuilds).toBe(1)

    layer.update(0.016) // no changes, no rebuild
    expect(rebuilds).toBe(1)

    layer.dispose()
  })

  it('removes an arc and shrinks the buffer', () => {
    const layer = new ArcLayer()
    const a = layer.addArc(LONDON, TOKYO)
    layer.addArc(LONDON, PARIS)
    build(layer)
    const twoArcs = layer.vertexCount

    expect(layer.removeArc(a)).toBe(true)
    build(layer)

    expect(layer.arcs).toHaveLength(1)
    expect(layer.vertexCount).toBeLessThan(twoArcs)

    layer.dispose()
  })

  it('reports false for an unknown arc id', () => {
    const layer = new ArcLayer()
    layer.addArc(LONDON, TOKYO)
    expect(layer.removeArc(9999)).toBe(false)
    layer.dispose()
  })

  it('draws nothing after clear', () => {
    const layer = new ArcLayer()
    layer.addArc(LONDON, TOKYO)
    build(layer)
    expect(layer.vertexCount).toBeGreaterThan(0)

    layer.clear()
    layer.update(0)
    expect(layer.geometry.drawRange.count).toBe(0)

    layer.dispose()
  })

  it('gives each arc a distinct pulse offset within one cycle', () => {
    const layer = new ArcLayer()
    const offsets = []
    for (let i = 0; i < 20; i++) {
      layer.addArc(LONDON, TOKYO)
      offsets.push(layer.arcs[i].offset)
    }

    expect(new Set(offsets).size).toBe(20)
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThan(1)
    }

    layer.dispose()
  })

  it('addArcs returns one id per entry', () => {
    const layer = new ArcLayer()
    const ids = layer.addArcs([
      { from: LONDON, to: TOKYO },
      { from: LONDON, to: PARIS, color: 0xff8844 },
    ])

    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    // The custom colour must survive into the arc record.
    expect(layer.arcs[1].color.getHex()).toBe(0xff8844)

    layer.dispose()
  })

  it('has no geometry until a frame runs, so callers must flush before drawing', () => {
    // This is the contract that made captureFrame produce arc-less images: the
    // rebuild is deferred to update(), which DreamGlobe only calls from its
    // requestAnimationFrame loop — and rAF never fires in a background tab.
    // Anything that renders outside that loop has to call update() itself.
    const layer = new ArcLayer()
    layer.addArcs([
      { from: LONDON, to: TOKYO },
      { from: LONDON, to: PARIS },
    ])

    expect(layer.arcs).toHaveLength(2)
    expect(layer.vertexCount).toBe(0)

    layer.update(0)
    expect(layer.vertexCount).toBeGreaterThan(0)
    expect(layer.geometry.drawRange.count).toBe(layer.vertexCount)

    layer.dispose()
  })
})
