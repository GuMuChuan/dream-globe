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
  scale = 1.09,
  color = 0x4b8fd4,
} = {}) {
  const geometry = new SphereGeometry(radius * scale, 64, 32)

  const material = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uIntensity: { value: 0.6 },
      uRadius: { value: radius },
      uScale: { value: scale },
    },
    vertexShader: /* glsl */ `
      varying vec3 vViewPosition;
      varying vec3 vCentreView;

      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = viewPosition.xyz;
        // The globe centre in view space. Constant across the mesh, but
        // deriving it here keeps the shader independent of any uniform the
        // caller might forget to update when the globe is transformed.
        vCentreView = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uRadius;
      uniform float uScale;

      varying vec3 vViewPosition;
      varying vec3 vCentreView;

      void main() {
        // Perpendicular distance from the camera-to-centre axis: the impact
        // parameter of this fragment's line of sight.
        vec3 axis = normalize(vCentreView);
        vec3 offset = vViewPosition - vCentreView;
        float b = length(offset - axis * dot(offset, axis));

        // 0 at the planet's limb, 1 at the outer edge of the shell.
        float t = clamp((b / uRadius - 1.0) / (uScale - 1.0), 0.0, 1.0);

        // Reaches exactly zero at t = 1, so the shell's silhouette contributes
        // nothing and never shows up as an edge.
        float glow = pow(1.0 - t, 3.0) * uIntensity;
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
