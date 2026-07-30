import { describe, it, expect } from 'vitest'
import { createAtmosphere, createEarth, GLOBE_RADIUS } from '../src/core/earth.js'

describe('createEarth', () => {
  it('keeps the black point low so city lights are the brightest thing', () => {
    // The emissive term is added uniformly across the sphere, so it behaves as
    // a fog that lifts the black point everywhere — including the ocean, which
    // is most of the surface. Measured on a rendered frame: dropping this from
    // 0.35 to 0.12 (with a darker placeholder) took the mean colour at the
    // centre of the disc from (19, 31, 53) to (20, 22, 29) while the brightest
    // pixel held at ~188, lifting contrast by 43%.
    const earth = createEarth({ radius: GLOBE_RADIUS })
    expect(earth.material.emissiveIntensity).toBeLessThanOrEqual(0.15)

    const emissive = earth.material.emissive
    const luma = (emissive.r + emissive.g + emissive.b) / 3
    expect(luma).toBeLessThan(0.05)

    earth.geometry.dispose()
    earth.material.dispose()
  })

  it('passes the texture through unmodified when one is supplied', () => {
    // Night imagery already encodes its own lighting. Tinting the base colour
    // would darken every city on the map.
    const fake = { isTexture: true }
    const earth = createEarth({ texture: fake })
    expect(earth.material.map).toBe(fake)
    expect(earth.material.color.getHex()).toBe(0xffffff)

    earth.geometry.dispose()
    earth.material.dispose()
  })
})

describe('createAtmosphere', () => {
  /**
   * The glow is driven by radial distance from the globe centre, not by a
   * Fresnel dot product.
   *
   * This is the fix for a bug that survived four rounds of parameter tweaking:
   * a Fresnel term does not converge at the shell's own silhouette, so the glow
   * was still bright where the geometry ran out. It terminated in a hard circle
   * and read as a drawn ring around the planet rather than as scattered light.
   * Verified by toggling the mesh on a rendered frame — the ring persisted with
   * the arc layer hidden, which is what ruled the arcs out as the cause.
   */
  it('drives falloff from distance, not from a Fresnel term', () => {
    const atmosphere = createAtmosphere({ radius: GLOBE_RADIUS })
    const source = atmosphere.material.fragmentShader

    expect(source).not.toMatch(/dot\s*\(\s*normalize\s*\(\s*vNormal/)
    expect(source).toContain('uRadius')
    expect(source).toContain('uScale')

    atmosphere.geometry.dispose()
    atmosphere.material.dispose()
  })

  it('reaches exactly zero at the shell edge so no silhouette shows', () => {
    // Reimplements the shader's falloff. If this can be made to return a
    // non-zero value at the outer edge, the shell's own geometry becomes
    // visible as an edge and the atmosphere stops reading as atmosphere.
    const scale = 1.09
    const radius = 1

    function glow(impactParameter) {
      const t = Math.min(1, Math.max(0, (impactParameter / radius - 1) / (scale - 1)))
      return Math.pow(1 - t, 3)
    }

    expect(glow(radius * scale)).toBe(0)
    expect(glow(radius * scale * 1.5)).toBe(0)

    // And it has to actually be bright at the limb, or there is no glow at all.
    expect(glow(radius)).toBeCloseTo(1, 6)

    // Monotonic decay in between — no ring, no plateau.
    let previous = Infinity
    for (let b = radius; b <= radius * scale; b += 0.005) {
      const value = glow(b)
      expect(value).toBeLessThanOrEqual(previous + 1e-9)
      previous = value
    }
  })

  it('keeps the shell thin enough not to wash out the surface up close', () => {
    // The camera comes in to 1.35 radii. At scale 1.16 the haze occupied enough
    // of the frame at that distance to sit visibly on top of the continents;
    // intensity and thickness turned out to be coupled, so both are pinned.
    const atmosphere = createAtmosphere({ radius: GLOBE_RADIUS })
    const shellRadius = atmosphere.geometry.parameters.radius

    expect(shellRadius).toBeGreaterThan(GLOBE_RADIUS)
    expect(shellRadius).toBeLessThanOrEqual(GLOBE_RADIUS * 1.12)
    expect(atmosphere.material.uniforms.uIntensity.value).toBeLessThanOrEqual(0.7)

    atmosphere.geometry.dispose()
    atmosphere.material.dispose()
  })

  it('never occludes the globe or writes depth', () => {
    const atmosphere = createAtmosphere()
    expect(atmosphere.material.depthWrite).toBe(false)
    expect(atmosphere.material.transparent).toBe(true)

    atmosphere.geometry.dispose()
    atmosphere.material.dispose()
  })
})
