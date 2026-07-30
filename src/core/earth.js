import {
  AdditiveBlending,
  BackSide,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SphereGeometry,
} from 'three'

export const GLOBE_RADIUS = 1

/**
 * The globe body: the textured Earth sphere plus its atmospheric rim.
 *
 * The rim is a slightly larger inverted sphere with a Fresnel-style falloff.
 * It is a cheap trick — two triangles' worth of shader work — but it is what
 * stops a night-Earth render from looking like a flat sticker on a black page.
 */
export function createEarth({ texture, radius = GLOBE_RADIUS, segments = 96 } = {}) {
  const geometry = new SphereGeometry(radius, segments, segments / 2)

  // Night lights are emissive, not lit: a MeshStandardMaterial with a light
  // rig would darken the terminator and hide half the cities. The imagery
  // already encodes the lighting, so it goes straight into the base colour.
  //
  // The emissive term is deliberately almost nothing. It is added uniformly
  // across the sphere, so any real value behaves as a fog that lifts the black
  // point everywhere — including the ocean, which is most of the surface. That
  // is what a night-Earth render must not do: the cities only read as lights
  // because the water around them is genuinely black.
  const material = new MeshStandardMaterial({
    map: texture ?? null,
    color: texture ? 0xffffff : 0x050a16,
    roughness: 1,
    metalness: 0,
    emissive: new Color(0x040810),
    emissiveIntensity: 0.12,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = 'earth'
  return mesh
}

/**
 * Atmospheric glow shell.
 *
 * Rendered with BackSide so we see the inside of the shell, and additively
 * blended so it only ever brightens.
 *
 * The falloff is driven by radial distance from the globe centre in screen
 * space, not by a Fresnel dot product. A Fresnel term seems like the natural
 * choice, but its value does not converge at the shell's own silhouette: the
 * glow is still bright where the geometry runs out, so it terminates in a hard
 * circle and reads as a drawn ring around the planet. Measuring distance
 * instead lets the falloff reach exactly zero at the shell edge, which is the
 * only way the edge stops being visible.
 */
export function createAtmosphere({
  radius = GLOBE_RADIUS,
  scale = 1.12,
  color = 0x4b8fd4,
} = {}) {
  const geometry = new SphereGeometry(radius * scale, 64, 32)

  const material = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uIntensity: { value: 1.5 },
      uRadius: { value: radius },
      uScale: { value: scale },
    },
    vertexShader: /* glsl */ `
      uniform float uRadius;
      uniform float uScale;

      varying float vRadial;

      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vec4 clipPosition = projectionMatrix * viewPosition;

        // The globe centre and a point exactly on the limb, both pushed through
        // the same projection. Comparing this fragment against them in clip
        // space gives a falloff parameter that is unambiguous: it is literally
        // "how far across the visible ring is this pixel", measured on screen.
        //
        // The obvious alternatives both fail here, and both were tried. A
        // Fresnel dot product does not converge at the shell's own silhouette,
        // so the glow is still bright where the geometry runs out. And the
        // fragment's distance to the camera-centre axis is not the same thing
        // as its screen radius: BackSide renders the far wall of the shell,
        // where perspective and grazing view angles make that distance run
        // backwards — measured on a rendered scanline, brightness increased
        // outwards and was cut off at full intensity by the mesh edge.
        vec4 centreClip = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec4 limbClip = projectionMatrix * (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)
          + vec4(uRadius, 0.0, 0.0, 0.0));

        vec2 centreNdc = centreClip.xy / centreClip.w;
        float limbNdc = abs(limbClip.x / limbClip.w - centreNdc.x);
        float outerNdc = limbNdc * uScale;

        float here = length(clipPosition.xy / clipPosition.w - centreNdc);
        vRadial = (here - limbNdc) / max(outerNdc - limbNdc, 1e-6);

        gl_Position = clipPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;

      varying float vRadial;

      void main() {
        // 0 at the planet's limb, 1 at the outer edge of the shell.
        float t = clamp(vRadial, 0.0, 1.0);

        // Two margins, and both are load-bearing.
        //
        // Inner: the glow must not be at full strength where it meets the
        // planet. The shell's t = 0 ring and the Earth's silhouette do not land
        // on the same pixel — measured on a 1200 px render, the globe's disc
        // was 502 px and the shell's 570 px, and the innermost fully-bright
        // fragments spilled about two pixels past the edge of the sphere that
        // was supposed to hide them. That spill is a hard white line tracing
        // the planet, which is the artefact that survived three earlier
        // rewrites of this shader. Ramping up from 0.06 keeps the brightest
        // fragments safely behind the globe.
        //
        // Outer: the glow has to die before the geometry does. Fading exactly
        // to the shell edge leaves a small non-zero value on the outermost ring
        // of fragments, and past that ring there is no mesh at all — so
        // brightness drops to nothing across a single pixel and the shell's own
        // silhouette shows up as a thin outline.
        float t2 = clamp((t - 0.06) / (0.82 - 0.06), 0.0, 1.0);

        // smoothstep, not pow: its derivative is zero at both ends, so the
        // gradient never stops abruptly enough to read as a band.
        float falloff = 1.0 - smoothstep(0.0, 1.0, t2);
        float glow = falloff * falloff * uIntensity;
        gl_FragColor = vec4(uColor, glow);
      }
    `,
    side: BackSide,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = 'atmosphere'
  return mesh
}

/**
 * Invisible pick target.
 *
 * Raycasting against the visible Earth works, but the visible mesh has 96
 * segments and gets swapped when textures change. A low-poly sphere reserved
 * for hit-testing keeps picking cheap and independent of visual changes.
 */
export function createPickSphere({ radius = GLOBE_RADIUS } = {}) {
  const mesh = new Mesh(
    new SphereGeometry(radius, 32, 16),
    new MeshBasicMaterial({ visible: false }),
  )
  mesh.name = 'pick-sphere'
  return mesh
}
