import {
  Cartesian3,
  Color,
  HeightReference,
  HorizontalOrigin,
  LabelStyle,
  VerticalOrigin,
  type Entity,
} from 'cesium'
import type { Asset, AssetType } from '../types'

// Visual descriptor for an asset. Renderer-agnostic: today returns Cesium primitive
// graphics; swap implementation for glTF models without touching call sites.
export type AssetVisual = {
  // Total visual height in meters, used for camera-fit and offset calculations.
  visualHeight: number
  // Returns the Cesium Entity init options to add for this asset.
  build(asset: Asset, opts: { selected: boolean }): Entity.ConstructorOptions
}

const TYPE_COLOR: Record<AssetType, string> = {
  jammer: '#e74c3c', // red
  sensor: '#3fb6f6', // cyan
  relay: '#f6d23f', // yellow
}

// glTF model URI per asset type. Files live in frontend/public/models so
// Vite serves them at /models/<file>.glb. Replaced the previous primitive
// cylinders for v0.1 — same Entity structure (one per asset) but now backed
// by a 3D mesh.
const MODEL_URI: Record<AssetType, string> = {
  jammer: '/models/jammer.glb',
  sensor: '/models/sensor.glb',
  relay: '/models/relay-tower.glb',
}

// World-space scale per type. The GLB files are at unit scale; these
// multipliers blow them up to roughly the correct meter-scale silhouette
// for the asset class. Tweakable as the operator finds them too big/small.
const MODEL_SCALE: Record<AssetType, number> = {
  jammer: 2.5,
  sensor: 0.1,
  relay: 1.0,
  // ^ relay tower is naturally tall in its source mesh; jammer is mid-sized;
  //   sensor mesh is large at unit scale so we shrink it down to a man-portable
  //   RF-sensor silhouette.
}

// Minimum on-screen pixel size — keeps the model legible even when the
// camera pulls far back. Higher number = stays bigger longer.
const MODEL_MIN_PIXEL_SIZE: Record<AssetType, number> = {
  jammer: 64,
  sensor: 56,
  relay: 80,
}

// Approximate visual height in meters — used for camera-fit and label
// offset calculations elsewhere. Estimates; refine if needed once we
// know the meshes' actual extents.
const MODEL_VISUAL_HEIGHT: Record<AssetType, number> = {
  jammer: 6,
  sensor: 4,
  relay: 35,
}

function modelVisual(type: AssetType): AssetVisual {
  return {
    visualHeight: MODEL_VISUAL_HEIGHT[type],
    build: (asset, { selected }) => ({
      id: asset.id,
      // Model origin sits AT the asset's stored position (which is the base
      // contact point in our convention). If a particular GLB is authored
      // with its origin at the centre or top, we'll see it floating / sunk
      // and can tweak per-type.
      position: Cartesian3.fromDegrees(asset.longitude, asset.latitude, asset.height),
      model: {
        uri: MODEL_URI[type],
        scale: MODEL_SCALE[type],
        minimumPixelSize: MODEL_MIN_PIXEL_SIZE[type],
        maximumScale: 200,
        // Selected → bright white outline. Unselected → faint type-coloured
        // outline so the asset's role is still readable at distance.
        silhouetteColor: selected
          ? Color.WHITE
          : Color.fromCssColorString(TYPE_COLOR[type]).brighten(0.4, new Color()),
        silhouetteSize: selected ? 3 : 1,
        runAnimations: false,
      },
      label: labelGraphics(asset.label, selected),
    }),
  }
}

export const primitiveVisuals: Record<AssetType, AssetVisual> = {
  jammer: modelVisual('jammer'),
  sensor: modelVisual('sensor'),
  relay: modelVisual('relay'),
}

function labelGraphics(text: string, selected: boolean) {
  return {
    text,
    font: '13px -apple-system, sans-serif',
    fillColor: Color.WHITE,
    outlineColor: Color.BLACK,
    outlineWidth: 2,
    style: LabelStyle.FILL_AND_OUTLINE,
    horizontalOrigin: HorizontalOrigin.CENTER,
    verticalOrigin: VerticalOrigin.BOTTOM,
    pixelOffset: new Cartesian3(0, -10, 0) as unknown as Cartesian3,
    heightReference: HeightReference.NONE,
    showBackground: selected,
    backgroundColor: Color.fromCssColorString('rgba(20, 24, 32, 0.7)'),
  }
}

export function visualFor(type: AssetType): AssetVisual {
  return primitiveVisuals[type]
}

export const ASSET_TYPE_COLOR = TYPE_COLOR

// Coverage isosurface threshold (dBm) per asset type. Voxel values above
// this define the volume rendered as the asset's coverage.
//
// Jammer threshold tightened to -40 dBm — Sionna ray tracing with multipath
// gain produces rx > -50 dBm across most urban AOIs, drowning building
// shadow detail. -40 brings the volume in close enough that shadows behind
// buildings become visible while still representing a realistic "jammer
// effective range" (this is the rx power that strongly overwhelms a typical
// drone control link).
export const COVERAGE_THRESHOLD_DBM: Record<AssetType, number> = {
  jammer: -40,
  sensor: -100,
  relay: -90,
}

// Translucent fill color per asset type for the coverage volume.
// Subtle alpha so multi-asset overlaps stay legible.
export const COVERAGE_VOLUME_RGBA: Record<AssetType, string> = {
  jammer: 'rgba(231, 76, 60, 0.14)',
  sensor: 'rgba(63, 182, 246, 0.14)',
  relay: 'rgba(246, 210, 63, 0.14)',
}

// Per-asset RGB triplet (without alpha — alpha is set per nested contour).
export const COVERAGE_VOLUME_RGB: Record<AssetType, [number, number, number]> = {
  jammer: [231, 76, 60],
  sensor: [63, 182, 246],
  relay: [246, 210, 63],
}

// Nested contour thresholds, in dB above the base threshold for each asset.
// Renders 3 shells per asset (fringe / strong / core) so the operator sees
// concentric "strength bands" instead of a single hollow shell — like a
// 3D version of topographic contours.
export const COVERAGE_CONTOUR_OFFSETS_DB = [0, 15, 30] as const
// Alpha per contour (matches order of CONTOUR_OFFSETS_DB).
export const COVERAGE_CONTOUR_ALPHA = [0.10, 0.18, 0.28] as const

// When a co-channel jammer is present and degrading a relay/sensor, render
// switches to a two-shell layout: a faded "ghost" of the nominal coverage
// at base threshold, plus a vivid effective shell inside it. The visible
// gap between them is the volume the jammer killed.
export const COVERAGE_NOMINAL_GHOST_ALPHA = 0.06
export const COVERAGE_EFFECTIVE_ALPHA = 0.22
