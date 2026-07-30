/**
 * Entry point for the plain <script> build.
 *
 * The ES module entry exports named symbols, which is right for bundler users.
 * But a <script> tag user expects `new DreamGlobe(el)` to just work, not
 * `new DreamGlobe.DreamGlobe(el)`. So the IIFE build points here instead: the
 * class is the default export and the helpers hang off it as statics.
 */
import { DreamGlobe } from './index.js'
import { GLOBE_RADIUS } from './core/earth.js'
import {
  angularDistance,
  greatCircleArc,
  latLngToVector3,
  vector3ToLatLng,
} from './core/coords.js'
import { MarkerLayer } from './core/markers.js'
import { ArcLayer } from './core/arcs.js'
import { GlobeControls } from './core/controls.js'

DreamGlobe.GLOBE_RADIUS = GLOBE_RADIUS
DreamGlobe.MarkerLayer = MarkerLayer
DreamGlobe.ArcLayer = ArcLayer
DreamGlobe.GlobeControls = GlobeControls
DreamGlobe.latLngToVector3 = latLngToVector3
DreamGlobe.vector3ToLatLng = vector3ToLatLng
DreamGlobe.angularDistance = angularDistance
DreamGlobe.greatCircleArc = greatCircleArc

export default DreamGlobe
