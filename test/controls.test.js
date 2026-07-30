import { describe, it, expect } from 'vitest'
import { PerspectiveCamera, Spherical } from 'three'
import { latLngToVector3 } from '../src/core/coords.js'
import { GlobeControls } from '../src/core/controls.js'

/** Minimal stand-in for a canvas: GlobeControls only attaches listeners. */
function fakeElement() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
  }
}

describe('GlobeControls camera placement', () => {
  it('moves the camera off the origin on the very first update', () => {
    // A PerspectiveCamera starts at (0, 0, 0), which is inside the globe.
    // Anything that renders or picks before the first update — a screenshot,
    // a background tab where requestAnimationFrame never fires — would see an
    // empty frame. One update call has to be enough to fix that.
    const camera = new PerspectiveCamera(45, 1, 0.1, 100)
    const controls = new GlobeControls(camera, fakeElement())

    expect(camera.position.length()).toBe(0)
    controls.update(0)
    expect(camera.position.length()).toBeGreaterThan(1)

    controls.dispose()
  })

  it('starts far enough out that the globe is not clipped', () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100)
    const controls = new GlobeControls(camera, fakeElement())
    controls.update(0)

    // Half-height of the view at the globe centre for a 45 degree vertical
    // FOV. The unit sphere plus its atmosphere needs to fit inside it.
    const halfHeight = camera.position.length() * Math.tan((45 / 2) * (Math.PI / 180))
    expect(halfHeight).toBeGreaterThan(1.1)

    controls.dispose()
  })
})

describe('GlobeControls.finishFlight', () => {
  it('lands the camera on the destination without waiting out the easing', async () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100)
    const controls = new GlobeControls(camera, fakeElement())
    controls.update(0)

    const flight = controls.flyTo(35.68, 139.69, { distance: 2.0, duration: 5000 })
    expect(controls.isFlying).toBe(true)

    controls.finishFlight()
    await flight

    expect(controls.isFlying).toBe(false)
    expect(controls.distance).toBeCloseTo(2.0, 6)

    // The camera should now sit above Tokyo: the direction from the origin to
    // the camera matches the direction to the surface point.
    const expected = latLngToVector3(35.68, 139.69, 1)
    const actual = camera.position.clone().normalize()
    expect(actual.dot(expected)).toBeGreaterThan(0.999)

    controls.dispose()
  })

  it('reports false when there is nothing to skip', () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100)
    const controls = new GlobeControls(camera, fakeElement())
    expect(controls.finishFlight()).toBe(false)
    controls.dispose()
  })

  it('resolves the flyTo promise when interrupted', async () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100)
    const controls = new GlobeControls(camera, fakeElement())
    controls.update(0)

    // A caller awaiting flyTo must never hang, even if a second flight or a
    // drag cuts the first one short.
    const first = controls.flyTo(0, 0, { duration: 5000 })
    controls.flyTo(51.5, -0.12, { duration: 5000 })
    await expect(first).resolves.toBeUndefined()

    controls.dispose()
  })
})

/**
 * The azimuth-unwrapping rule used by GlobeControls.flyTo, extracted so it can
 * be tested without a DOM. Keep in sync with controls.js.
 */
function unwrapAzimuth(current, destination) {
  let theta = destination
  while (theta - current > Math.PI) theta -= Math.PI * 2
  while (theta - current < -Math.PI) theta += Math.PI * 2
  return theta
}

describe('flyTo azimuth unwrapping', () => {
  it('never rotates more than half a turn', () => {
    const samples = [
      [0, 3.0], [0, -3.0], [3.0, -3.0], [-3.0, 3.0],
      [1.5, 4.9], [-2.9, 2.9], [0.1, 6.2],
    ]

    for (const [current, destination] of samples) {
      const unwrapped = unwrapAzimuth(current, destination)
      expect(Math.abs(unwrapped - current)).toBeLessThanOrEqual(Math.PI + 1e-9)
    }
  })

  it('keeps the destination pointing at the same place on the globe', () => {
    const current = 3.0
    const destination = -3.0
    const unwrapped = unwrapAzimuth(current, destination)

    // Unwrapping may only add whole turns, so the angle must stay congruent.
    const turns = (unwrapped - destination) / (Math.PI * 2)
    expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-9)
  })

  it('takes the short way when the camera has accumulated rotation', () => {
    const tokyo = new Spherical().setFromVector3(latLngToVector3(35.68, 139.69, 1))
    const la = new Spherical().setFromVector3(latLngToVector3(34.05, -118.24, 1))

    // Spherical.setFromVector3 already normalises theta into (-pi, pi], so the
    // interesting case is a camera that has been dragged several turns: its
    // theta is far outside that range and a raw difference would spin the
    // globe through every intervening turn.
    const draggedCamera = tokyo.theta + Math.PI * 6

    const naive = Math.abs(la.theta - draggedCamera)
    const actual = Math.abs(unwrapAzimuth(draggedCamera, la.theta) - draggedCamera)

    expect(naive).toBeGreaterThan(Math.PI * 5)
    expect(actual).toBeLessThan(Math.PI)
  })
})

describe('pole clamping', () => {
  const POLE_EPSILON = 0.05

  function clampPhi(phi) {
    return Math.min(Math.PI - POLE_EPSILON, Math.max(POLE_EPSILON, phi))
  }

  it('never reaches the exact poles where the camera basis degenerates', () => {
    expect(clampPhi(0)).toBeGreaterThan(0)
    expect(clampPhi(-5)).toBeGreaterThan(0)
    expect(clampPhi(Math.PI)).toBeLessThan(Math.PI)
    expect(clampPhi(99)).toBeLessThan(Math.PI)
  })

  it('leaves ordinary angles untouched', () => {
    expect(clampPhi(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
  })
})

describe('frame-rate independent damping', () => {
  function settle(deltaMs, frames, damping = 0.12) {
    let value = 0
    for (let i = 0; i < frames; i++) {
      const alpha = 1 - Math.exp(-damping * (deltaMs / 16.667))
      value += (1 - value) * alpha
    }
    return value
  }

  it('reaches the same position after the same elapsed time at 60 and 144 Hz', () => {
    // 500 ms of animation, sampled at two very different frame rates.
    const at60 = settle(16.667, 30)
    const at144 = settle(6.944, 72)
    expect(Math.abs(at60 - at144)).toBeLessThan(0.01)
  })
})
