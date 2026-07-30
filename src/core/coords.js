import { Vector3 } from 'three'

/**
 * Geographic <-> Cartesian conversion and great-circle helpers.
 *
 * All functions here are pure and unit-tested. Getting these wrong is the
 * single most common source of "my markers are in the wrong place" bugs,
 * so they live in their own module with no Three.js scene dependencies
 * beyond the Vector3 value type.
 */

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/**
 * Convert latitude/longitude to a Cartesian position on a sphere.
 *
 * Convention used throughout this library:
 *   - Y is the polar axis (north pole at +Y), matching Three.js SphereGeometry.
 *   - Longitude 0 faces +Z, increasing eastward.
 *
 * This must match the UV mapping of the texture applied to the sphere,
 * otherwise markers drift horizontally relative to the coastlines.
 *
 * @param {number} lat  Latitude in degrees, -90..90
 * @param {number} lng  Longitude in degrees, -180..180
 * @param {number} radius Sphere radius
 * @param {Vector3} [target] Optional vector to write into, avoids allocation
 * @returns {Vector3}
 */
export function latLngToVector3(lat, lng, radius = 1, target = new Vector3()) {
  const phi = (90 - lat) * DEG2RAD // polar angle from +Y
  const theta = (lng + 180) * DEG2RAD // azimuthal angle

  return target.set(
    -radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.cos(theta),
  )
}

/**
 * Inverse of latLngToVector3. Used for picking: turn a ray/sphere
 * intersection point back into geographic coordinates.
 *
 * @param {Vector3} v
 * @returns {{lat: number, lng: number}}
 */
export function vector3ToLatLng(v) {
  const radius = v.length()
  if (radius === 0) return { lat: 0, lng: 0 }

  const lat = 90 - Math.acos(clamp(v.y / radius, -1, 1)) * RAD2DEG
  let lng = Math.atan2(-v.x, v.z) * RAD2DEG - 180

  // Normalise into (-180, 180]
  lng = ((((lng + 180) % 360) + 360) % 360) - 180

  return { lat, lng }
}

/**
 * Angular distance between two geographic points, in radians.
 *
 * Uses the haversine form rather than the naive spherical law of cosines,
 * because the latter loses precision for small distances — which matters
 * when two markers sit in the same city.
 */
export function angularDistance(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG2RAD
  const dLng = (lng2 - lng1) * DEG2RAD
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLng / 2) ** 2

  return 2 * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Sample points along the great-circle path between two coordinates,
 * lifted above the surface to form an arc.
 *
 * The lift profile is a sine bump: zero at both endpoints, peak in the
 * middle. Peak height scales with angular distance, so short hops stay
 * flat against the globe and long hauls bow out visibly — a constant
 * height looks wrong at both extremes.
 *
 * Interpolation is done with spherical linear interpolation on the two
 * endpoint vectors. Interpolating lat/lng directly would bend the path
 * away from the true great circle and break down entirely near the poles.
 *
 * @returns {Vector3[]}
 */
export function greatCircleArc(lat1, lng1, lat2, lng2, {
  radius = 1,
  segments = 64,
  liftScale = 0.35,
} = {}) {
  const start = latLngToVector3(lat1, lng1, radius)
  const end = latLngToVector3(lat2, lng2, radius)
  const omega = angularDistance(lat1, lng1, lat2, lng2)

  // Antipodal or identical points have no unique great circle / no length.
  const degenerate = omega < 1e-9 || Math.abs(omega - Math.PI) < 1e-9
  const maxLift = radius * liftScale * (omega / Math.PI)

  const points = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const point = degenerate
      ? start.clone().lerp(end, t).setLength(radius)
      : slerpOnSphere(start, end, omega, t, radius)

    point.multiplyScalar(1 + (maxLift / radius) * Math.sin(Math.PI * t))
    points.push(point)
  }

  return points
}

/**
 * Spherical linear interpolation between two points on a sphere of the
 * given radius. Kept separate so the arc builder stays readable.
 */
function slerpOnSphere(start, end, omega, t, radius) {
  const sinOmega = Math.sin(omega)
  const a = Math.sin((1 - t) * omega) / sinOmega
  const b = Math.sin(t * omega) / sinOmega

  return new Vector3(
    a * start.x + b * end.x,
    a * start.y + b * end.y,
    a * start.z + b * end.z,
  ).setLength(radius)
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
