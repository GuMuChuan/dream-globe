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
    const fragment = atmosphere.material.fragmentShader
    const vertex = atmosphere.material.vertexShader

    expect(fragment).not.toMatch(/dot\s*\(\s*normalize\s*\(\s*vNormal/)
    expect(vertex).toContain('uRadius')
    expect(vertex).toContain('uScale')

    atmosphere.geometry.dispose()
    atmosphere.material.dispose()
  })

  /**
   * The falloff parameter is a screen-space radius, computed in clip space.
   *
   * Regression test for the third attempt at this shader. The shell renders
   * BackSide, so every fragment sits on the far wall of the sphere, seen at a
   * grazing angle. Neither the fragment's distance to the camera-centre axis
   * nor the eye ray's closest approach to the centre tracks its screen radius
   * there — measured on a rendered scanline, the resulting brightness ran
   * *outwards* from the limb and was cut off at full intensity by the mesh
   * edge, producing exactly the hard outline the falloff exists to prevent.
   *
   * Projecting the globe centre and a limb point through the same matrices and
   * comparing in NDC sidesteps all of it: the parameter is then, by
   * construction, "how far across the visible ring is this pixel".
   */
  it('measures screen radius in clip space, not a view-space distance', () => {
    const atmosphere = createAtmosphere({ radius: GLOBE_RADIUS })
    const vertex = atmosphere.material.vertexShader

    // Centre and limb both projected, then compared after the perspective
    // divide. The divide is the part that cannot be skipped.
    expect(vertex).toMatch(/centreClip\.xy\s*\/\s*centreClip\.w/)
    expect(vertex).toMatch(/clipPosition\.xy\s*\/\s*clipPosition\.w/)

    // The rejected formulations must not come back.
    expect(vertex).not.toMatch(/vViewPosition\s*-\s*vCentreView/)
    expect(vertex).not.toMatch(/normalize\s*\(\s*vViewPosition\s*\)/)

    atmosphere.geometry.dispose()
    atmosphere.material.dispose()
  })

  it('reaches exactly zero at the shell edge so no silhouette shows', () => {
    // Reimplements the shader's falloff. If this can be made to return a
    // non-zero value at the outer edge, the shell's own geometry becomes
    // visible as an edge and the atmosphere stops reading as atmosphere.
    const scale = 1.09
    const radius = 1

    function smoothstep(edge0, edge1, x) {
      const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
      return t * t * (3 - 2 * t)
    }

    function glow(impactParameter) {
      const t = Math.min(1, Math.max(0, (impactParameter / radius - 1) / (scale - 1)))
      const t2 = Math.min(1, Math.max(0, (t - 0.06) / (0.82 - 0.06)))
      const falloff = 1 - smoothstep(0, 1, t2)
      return falloff * falloff
    }

    expect(glow(radius * scale)).toBe(0)
    expect(glow(radius * scale * 1.5)).toBe(0)

    // Zero is reached before the geometry ends, leaving transparent margin.
    // That margin is the whole point: it is what stops the shell's silhouette
    // from appearing as an outline around the planet.
    expect(glow(radius + (scale - 1) * radius * 0.82)).toBe(0)
    expect(glow(radius + (scale - 1) * radius * 0.7)).toBeGreaterThan(0)

    // And it has to actually be bright at the limb, or there is no glow at all.
    expect(glow(radius)).toBeCloseTo(1, 6)

    // The peak is held flat across the inner margin, so the brightest fragments
    // stay behind the globe rather than spilling past its silhouette.
    expect(glow(radius + (scale - 1) * radius * 0.06)).toBeCloseTo(1, 6)

    // Monotonic decay in between — no ring, no plateau.
    let previous = Infinity
    for (let b = radius; b <= radius * scale; b += 0.005) {
      const value = glow(b)
      expect(value).toBeLessThanOrEqual(previous + 1e-9)
      previous = value
    }
  })

  it('lands on the shell edge with zero slope, not just zero value', () => {
    // The bug this pins down: pow(1 - t, 3) reaches zero at the edge but its
    // gradient does not, and the abrupt change in slope renders as a second
    // faint ring outside the atmosphere. Only visible at high resolution,
    // which is exactly where documentation screenshots get taken.
    const scale = 1.09

    function smoothstep(edge0, edge1, x) {
      const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
      return t * t * (3 - 2 * t)
    }

    function glow(t) {
      const clamped = Math.min(1, Math.max(0, t))
      const t2 = Math.min(1, Math.max(0, (clamped - 0.06) / (0.82 - 0.06)))
      const falloff = 1 - smoothstep(0, 1, t2)
      return falloff * falloff
    }

    // Numerical slope just inside the outer edge must be essentially flat.
    const h = 1e-4
    const slopeAtEdge = Math.abs(glow(1 - h) - glow(1)) / h
    expect(slopeAtEdge).toBeLessThan(0.01)

    // For contrast, the rejected curve: pow(1 - t, 3) leaves a real slope.
    const rejected = (t) => Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
    const rejectedSlope = Math.abs(rejected(1 - h) - rejected(1)) / h
    expect(rejectedSlope).toBeGreaterThan(slopeAtEdge)

    expect(scale).toBeGreaterThan(1)
  })

  it('keeps the shell thin enough not to wash out the surface up close', () => {
    // The camera comes in to 1.35 radii. At scale 1.16 the haze occupied enough
    // of the frame at that distance to sit visibly on top of the continents.
    //
    // Intensity is allowed to be well above 1 here because the two falloff
    // margins spend most of it: the curve ramps in from t = 0.06 and is squared
    // on the way out, so the peak only ever lands in the couple of pixels
    // hidden behind the globe. Measured on a 1200 px render, an intensity of
    // 0.6 left the entire visible annulus below the 8-bit quantisation floor —
    // a glow that exists in the framebuffer and nowhere on screen.
    const atmosphere = createAtmosphere({ radius: GLOBE_RADIUS })
    const shellRadius = atmosphere.geometry.parameters.radius

    expect(shellRadius).toBeGreaterThan(GLOBE_RADIUS)
    expect(shellRadius).toBeLessThanOrEqual(GLOBE_RADIUS * 1.12)
    expect(atmosphere.material.uniforms.uIntensity.value).toBeGreaterThan(1)
    expect(atmosphere.material.uniforms.uIntensity.value).toBeLessThanOrEqual(2)

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

  /**
   * The falloff must be isotropic on screen, which means the shader needs the
   * viewport's aspect ratio.
   *
   * The bug: NDC spans -1..1 on both axes whatever the viewport's shape, so one
   * NDC unit is a different number of pixels horizontally than vertically. The
   * limb reference is measured along x only, so an unscaled two-dimensional NDC
   * length compares against the wrong yardstick on the y axis. The shader was
   * tuned on a 2400x1350 landscape frame, where the error was small and got
   * absorbed into uIntensity; on the 852x932 portrait viewport of the deployed
   * demo the fade was pushed outwards vertically and the rim rendered as a
   * thick, saturated blue band. Same code, same parameters, different window
   * shape — which is why the screenshots looked right and the build did not.
   */
  it('normalises the falloff by aspect ratio so it is viewport-independent', () => {
    const atmosphere = createAtmosphere({ radius: GLOBE_RADIUS })
    const vertex = atmosphere.material.vertexShader

    // The uniform has to exist, and the shader has to actually divide by it.
    expect(atmosphere.material.uniforms.uResolution).toBeDefined()
    expect(vertex).toContain('uResolution')
    expect(vertex).toMatch(/uResolution\.x\s*\/\s*max\s*\(\s*uResolution\.y/)
    expect(vertex).toMatch(/offsetNdc\.y\s*\/=\s*aspect/)

    // The raw NDC length must not be used directly any more: that is the form
    // that carried the bug.
    expect(vertex).not.toMatch(/length\s*\(\s*clipPosition\.xy\s*\/\s*clipPosition\.w\s*-/)

    atmosphere.geometry.dispose()
    atmosphere.material.dispose()
  })

  it('produces the same falloff on portrait and landscape viewports', () => {
    // Reimplements the corrected screen-space measurement. The assertion that
    // matters is that a fragment at a given *pixel* radius gets the same glow
    // regardless of the viewport's shape.
    const scale = 1.09
    const limbNdc = 0.4

    function radialFor({ ndcX, ndcY, aspect }) {
      const y = ndcY / aspect
      const here = Math.hypot(ndcX, y)
      return (here - limbNdc) / Math.max(limbNdc * scale - limbNdc, 1e-6)
    }

    // A point straight above the centre, at the same physical screen distance
    // from it as the limb, expressed in each viewport's own NDC units.
    const portrait = { w: 852, h: 932 }
    const landscape = { w: 2400, h: 1350 }

    for (const viewport of [portrait, landscape]) {
      const aspect = viewport.w / viewport.h
      // Vertical offset whose isotropic length equals limbNdc.
      const ndcY = limbNdc * aspect
      const t = radialFor({ ndcX: 0, ndcY, aspect })
      expect(t).toBeCloseTo(0, 6)
    }

    // And the uncorrected form disagrees between the two, which is the bug.
    const naive = ({ ndcY }) => (Math.abs(ndcY) - limbNdc) / (limbNdc * scale - limbNdc)
    const naivePortrait = naive({ ndcY: limbNdc * (portrait.w / portrait.h) })
    const naiveLandscape = naive({ ndcY: limbNdc * (landscape.w / landscape.h) })
    expect(Math.abs(naivePortrait - naiveLandscape)).toBeGreaterThan(0.5)
  })
})
