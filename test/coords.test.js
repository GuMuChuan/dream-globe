import { describe, it, expect } from 'vitest'
import { Vector3 } from 'three'
import {
  latLngToVector3,
  vector3ToLatLng,
  angularDistance,
  greatCircleArc,
} from '../src/core/coords.js'

const EARTH_MEAN_RADIUS_KM = 6371

describe('latLngToVector3', () => {
  it('puts the north pole on +Y', () => {
    const v = latLngToVector3(90, 0, 1)
    expect(v.y).toBeCloseTo(1, 10)
    expect(v.x).toBeCloseTo(0, 10)
    expect(v.z).toBeCloseTo(0, 10)
  })

  it('puts the south pole on -Y', () => {
    const v = latLngToVector3(-90, 0, 1)
    expect(v.y).toBeCloseTo(-1, 10)
  })

  it('always lands exactly on the sphere surface', () => {
    const samples = [
      [0, 0], [45, 90], [-33.9, 151.2], [51.5, -0.13], [-90, 180], [12, -179.9],
    ]
    for (const [lat, lng] of samples) {
      expect(latLngToVector3(lat, lng, 5).length()).toBeCloseTo(5, 10)
    }
  })

  it('writes into the provided target without allocating', () => {
    const target = new Vector3()
    const result = latLngToVector3(10, 20, 1, target)
    expect(result).toBe(target)
  })
})

describe('vector3ToLatLng', () => {
  it('round-trips a spread of coordinates', () => {
    const samples = [
      [0, 0], [45, 90], [-33.87, 151.21], [51.51, -0.13],
      [35.68, 139.69], [-54.8, -68.3], [78.2, 15.6],
    ]

    for (const [lat, lng] of samples) {
      const back = vector3ToLatLng(latLngToVector3(lat, lng, 3))
      expect(back.lat).toBeCloseTo(lat, 6)
      expect(back.lng).toBeCloseTo(lng, 6)
    }
  })

  it('normalises longitude into (-180, 180]', () => {
    const back = vector3ToLatLng(latLngToVector3(0, 179.999, 1))
    expect(back.lng).toBeGreaterThan(-180)
    expect(back.lng).toBeLessThanOrEqual(180)
  })

  it('does not blow up at the origin', () => {
    expect(vector3ToLatLng(new Vector3(0, 0, 0))).toEqual({ lat: 0, lng: 0 })
  })
})

describe('angularDistance', () => {
  it('is zero for identical points', () => {
    expect(angularDistance(12.3, 45.6, 12.3, 45.6)).toBeCloseTo(0, 12)
  })

  it('is pi for antipodal points', () => {
    expect(angularDistance(0, 0, 0, 180)).toBeCloseTo(Math.PI, 10)
    expect(angularDistance(90, 0, -90, 0)).toBeCloseTo(Math.PI, 10)
  })

  it('matches the known London to New York distance', () => {
    // Reference: ~5570 km great-circle, tolerance 20 km.
    const km = angularDistance(51.5074, -0.1278, 40.7128, -74.006) * EARTH_MEAN_RADIUS_KM
    expect(km).toBeGreaterThan(5550)
    expect(km).toBeLessThan(5590)
  })

  it('stays accurate for short distances where law-of-cosines degrades', () => {
    // Two points ~1.1 km apart in central London.
    const km = angularDistance(51.5074, -0.1278, 51.5174, -0.1278) * EARTH_MEAN_RADIUS_KM
    expect(km).toBeGreaterThan(1.0)
    expect(km).toBeLessThan(1.2)
  })
})

describe('greatCircleArc', () => {
  it('starts and ends exactly on the surface', () => {
    const pts = greatCircleArc(51.5, -0.13, 40.71, -74.01, { radius: 2, segments: 32 })
    expect(pts).toHaveLength(33)
    expect(pts[0].length()).toBeCloseTo(2, 8)
    expect(pts[pts.length - 1].length()).toBeCloseTo(2, 8)
  })

  it('lifts the middle of the arc above the surface', () => {
    const pts = greatCircleArc(51.5, -0.13, 40.71, -74.01, { radius: 2, segments: 32 })
    const middle = pts[16].length()
    expect(middle).toBeGreaterThan(2)
  })

  it('bows out further for longer routes', () => {
    const opts = { radius: 1, segments: 32 }
    const shortHop = greatCircleArc(51.5, -0.13, 48.85, 2.35, opts) // London-Paris
    const longHaul = greatCircleArc(51.5, -0.13, -33.87, 151.21, opts) // London-Sydney

    const shortPeak = Math.max(...shortHop.map((p) => p.length()))
    const longPeak = Math.max(...longHaul.map((p) => p.length()))
    expect(longPeak).toBeGreaterThan(shortPeak)
  })

  it('handles identical endpoints without NaN', () => {
    const pts = greatCircleArc(10, 20, 10, 20, { radius: 1, segments: 8 })
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      expect(Number.isFinite(p.z)).toBe(true)
    }
  })

  it('handles antipodal endpoints without NaN', () => {
    const pts = greatCircleArc(0, 0, 0, 180, { radius: 1, segments: 8 })
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.length())).toBe(true)
    }
  })

  it('crosses the date line without a detour', () => {
    // Tokyo to Los Angeles crosses the 180th meridian. A lat/lng-interpolated
    // path would swing the wrong way around the globe; a true great circle
    // keeps every sample within the northern Pacific band.
    const pts = greatCircleArc(35.68, 139.69, 34.05, -118.24, { radius: 1, segments: 64 })
    for (const p of pts) {
      const { lat } = vector3ToLatLng(p)
      expect(lat).toBeGreaterThan(20)
      expect(lat).toBeLessThan(70)
    }
  })
})
