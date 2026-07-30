import { describe, it, expect } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { latLngToVector3 } from '../src/core/coords.js'
import { MarkerLayer } from '../src/core/markers.js'

/**
 * A stand-in for the canvas. MarkerLayer.pick only ever asks for the bounding
 * rect, so a plain object is enough and no WebGL context is needed — three
 * builds the InstancedMesh lazily and only touches the GPU at render time.
 */
function fakeCanvas(width = 800, height = 800) {
  return { getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) }
}

/** Camera parked directly above a coordinate, looking at the globe centre. */
function cameraOver(lat, lng, distance = 3.2) {
  const camera = new PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.copy(latLngToVector3(lat, lng, distance))
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  return camera
}

describe('MarkerLayer.pick', () => {
  it('picks the marker facing the camera and rejects the one behind the globe', () => {
    const layer = new MarkerLayer({ radius: 1 })
    const front = layer.addMarker(0, 0, { name: 'front' })
    const back = layer.addMarker(0, 180, { name: 'back' })

    // Both markers project to the exact centre of the screen. Without
    // back-face rejection the far one would be pickable through the Earth.
    const centre = { clientX: 400, clientY: 400 }

    expect(layer.pick(centre, cameraOver(0, 0), fakeCanvas()).id).toBe(front)
    expect(layer.pick(centre, cameraOver(0, 180), fakeCanvas()).id).toBe(back)

    layer.dispose()
  })

  it('returns null when the pointer is nowhere near a marker', () => {
    const layer = new MarkerLayer({ radius: 1 })
    layer.addMarker(0, 0, { name: 'front' })

    const result = layer.pick({ clientX: 100, clientY: 100 }, cameraOver(0, 0), fakeCanvas())
    expect(result).toBeNull()

    layer.dispose()
  })

  it('returns null for an empty layer', () => {
    const layer = new MarkerLayer({ radius: 1 })
    expect(layer.pick({ clientX: 400, clientY: 400 }, cameraOver(0, 0), fakeCanvas())).toBeNull()
    layer.dispose()
  })

  it('hands back the payload attached at add time', () => {
    const layer = new MarkerLayer({ radius: 1 })
    layer.addMarker(35.68, 139.69, { title: 'Tokyo', pop: '37.4M' })

    const hit = layer.pick({ clientX: 400, clientY: 400 }, cameraOver(35.68, 139.69), fakeCanvas())
    expect(hit.data.title).toBe('Tokyo')
    expect(hit.lat).toBeCloseTo(35.68, 6)
    expect(hit.lng).toBeCloseTo(139.69, 6)

    layer.dispose()
  })

  it('prefers the nearer marker when two are close together on screen', () => {
    const layer = new MarkerLayer({ radius: 1 })
    const centred = layer.addMarker(0, 0, { name: 'centred' })
    layer.addMarker(0, 2, { name: 'offset' })

    const hit = layer.pick({ clientX: 400, clientY: 400 }, cameraOver(0, 0), fakeCanvas())
    expect(hit.id).toBe(centred)

    layer.dispose()
  })

  it('respects a tightened pixel threshold', () => {
    const layer = new MarkerLayer({ radius: 1 })
    layer.addMarker(0, 0, {})
    const camera = cameraOver(0, 0)

    // Ten pixels off centre: inside the default 18 px target, outside a 4 px one.
    const nearby = { clientX: 410, clientY: 400 }
    expect(layer.pick(nearby, camera, fakeCanvas())).not.toBeNull()
    expect(layer.pick(nearby, camera, fakeCanvas(), { thresholdPx: 4 })).toBeNull()

    layer.dispose()
  })
})

describe('MarkerLayer bookkeeping', () => {
  it('keeps instance count in step with the marker list', () => {
    const layer = new MarkerLayer({ radius: 1 })
    const a = layer.addMarker(0, 0, {})
    layer.addMarker(10, 10, {})
    const c = layer.addMarker(20, 20, {})

    expect(layer.mesh.count).toBe(3)

    layer.removeMarker(a)
    expect(layer.mesh.count).toBe(2)
    expect(layer.markers.map((m) => m.id)).not.toContain(a)
    expect(layer.markers.map((m) => m.id)).toContain(c)

    layer.clear()
    expect(layer.mesh.count).toBe(0)

    layer.dispose()
  })

  it('reports false when removing an id that is not there', () => {
    const layer = new MarkerLayer({ radius: 1 })
    layer.addMarker(0, 0, {})
    expect(layer.removeMarker(9999)).toBe(false)
    layer.dispose()
  })

  it('grows past its initial capacity without losing markers', () => {
    const layer = new MarkerLayer({ radius: 1, capacity: 4 })
    const ids = []
    for (let i = 0; i < 40; i++) ids.push(layer.addMarker(i, i, { i }))

    expect(layer.markers).toHaveLength(40)
    expect(layer.mesh.count).toBe(40)
    expect(new Set(ids).size).toBe(40)

    // The last marker added must still be pickable after several reallocations.
    const last = layer.markers[layer.markers.length - 1]
    const hit = layer.pick(
      { clientX: 400, clientY: 400 },
      cameraOver(last.lat, last.lng),
      fakeCanvas(),
    )
    expect(hit.id).toBe(last.id)

    layer.dispose()
  })

  it('assigns each marker a distinct phase so clusters do not blink in unison', () => {
    const layer = new MarkerLayer({ radius: 1 })
    const phases = []
    for (let i = 0; i < 20; i++) {
      layer.addMarker(i, i, {})
      phases.push(layer.markers[i].phase)
    }

    expect(new Set(phases).size).toBe(20)
    for (const phase of phases) {
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(Math.PI * 2)
    }

    layer.dispose()
  })

  it('addMarkers splits geometry fields from the payload', () => {
    const layer = new MarkerLayer({ radius: 1 })
    layer.addMarkers([{ lat: 51.5, lng: -0.12, title: 'London', scale: 2 }])

    const marker = layer.markers[0]
    expect(marker.lat).toBe(51.5)
    expect(marker.scale).toBe(2)
    expect(marker.data).toEqual({ title: 'London' })
    // lat/lng/scale must not leak into the payload handed back on click.
    expect(marker.data.lat).toBeUndefined()

    layer.dispose()
  })
})

/**
 * Back-face rejection rule used by MarkerLayer.pick, isolated so the geometry
 * can be checked at many angles cheaply. Keep in sync with markers.js.
 *
 * A marker is visible when the vector from the marker to the camera points
 * outward relative to the marker's own surface normal. On a sphere centred at
 * the origin the surface normal is the position itself, so the test reduces to
 * a single dot product.
 */
function isFacingCamera(markerPosition, cameraPosition) {
  const toCamera = cameraPosition.clone().sub(markerPosition)
  return markerPosition.dot(toCamera) > 0
}

describe('marker back-face rejection', () => {
  // Camera parked over the Gulf of Guinea (0, 0) at 2.6 radii out.
  const camera = latLngToVector3(0, 0, 2.6)

  it('accepts a marker directly under the camera', () => {
    const marker = latLngToVector3(0, 0, 1.002)
    expect(isFacingCamera(marker, camera)).toBe(true)
  })

  it('rejects a marker on the exact opposite side', () => {
    const marker = latLngToVector3(0, 180, 1.002)
    expect(isFacingCamera(marker, camera)).toBe(false)
  })

  it('rejects markers past the visible horizon', () => {
    // For a camera at distance d on a unit sphere, the horizon sits at
    // acos(1/d) from the sub-camera point. At d = 2.6 that is ~67.4 degrees.
    const beyondHorizon = latLngToVector3(0, 75, 1.002)
    expect(isFacingCamera(beyondHorizon, camera)).toBe(false)
  })

  it('accepts markers comfortably inside the horizon', () => {
    const inside = latLngToVector3(0, 55, 1.002)
    expect(isFacingCamera(inside, camera)).toBe(true)
  })

  it('is symmetric around the sub-camera point', () => {
    for (const lng of [30, -30, 50, -50]) {
      const marker = latLngToVector3(0, lng, 1.002)
      const mirrored = latLngToVector3(0, -lng, 1.002)
      expect(isFacingCamera(marker, camera)).toBe(isFacingCamera(mirrored, camera))
    }
  })

  it('holds for a camera over the north pole', () => {
    const polarCamera = latLngToVector3(90, 0, 3)
    expect(isFacingCamera(latLngToVector3(80, 0, 1.002), polarCamera)).toBe(true)
    expect(isFacingCamera(latLngToVector3(-80, 0, 1.002), polarCamera)).toBe(false)
  })
})

describe('marker surface offset', () => {
  it('lifts markers just above the globe to avoid z-fighting', () => {
    const globeRadius = 1
    const marker = latLngToVector3(45, 90, globeRadius * 1.002)
    expect(marker.length()).toBeGreaterThan(globeRadius)
    // But not so far that it visibly floats.
    expect(marker.length()).toBeLessThan(globeRadius * 1.01)
  })

  it('keeps the offset proportional for a scaled globe', () => {
    const marker = latLngToVector3(0, 0, 5 * 1.002)
    expect(marker.length()).toBeCloseTo(5.01, 6)
  })
})

describe('dense instance ordering', () => {
  /** Mirrors the splice-and-rewrite strategy in MarkerLayer.removeMarker. */
  function removeAt(list, index) {
    const next = [...list]
    next.splice(index, 1)
    return next
  }

  it('keeps the array dense after a middle removal', () => {
    const markers = [1, 2, 3, 4, 5]
    const after = removeAt(markers, 2)
    expect(after).toEqual([1, 2, 4, 5])
    expect(after).toHaveLength(4)
    expect(after.includes(undefined)).toBe(false)
  })

  it('survives removing every element one by one', () => {
    let markers = [1, 2, 3, 4, 5]
    while (markers.length > 0) {
      markers = removeAt(markers, 0)
    }
    expect(markers).toHaveLength(0)
  })
})

describe('capacity growth', () => {
  function grow(capacity, needed, factor = 2) {
    return Math.max(capacity * factor, needed)
  }

  it('doubles rather than growing by one', () => {
    expect(grow(256, 257)).toBe(512)
  })

  it('jumps straight to the required size for a large bulk insert', () => {
    expect(grow(256, 5000)).toBe(5000)
  })

  it('reaches 1000 capacity in few reallocations from the default', () => {
    let capacity = 256
    let reallocations = 0
    while (capacity < 1000) {
      capacity = grow(capacity, capacity + 1)
      reallocations++
    }
    expect(reallocations).toBeLessThanOrEqual(2)
  })
})

describe('Vector3 sanity', () => {
  it('dot product sign matches the visibility intuition', () => {
    const outward = new Vector3(1, 0, 0)
    expect(outward.dot(new Vector3(1, 0, 0))).toBeGreaterThan(0)
    expect(outward.dot(new Vector3(-1, 0, 0))).toBeLessThan(0)
  })
})
