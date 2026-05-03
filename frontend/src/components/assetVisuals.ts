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

// v0.1 default: distinct cylindrical silhouettes per asset type, plus a label.
// One Entity per asset; the cylinder graphic is positioned with its CENTER at the
// asset position raised by visualHeight/2 so the BASE sits at the asset's stored
// (lat, lon, height). Geometry parameters chosen to give each type a recognizable
// silhouette from any angle.
export const primitiveVisuals: Record<AssetType, AssetVisual> = {
  jammer: {
    visualHeight: 25,
    build: (asset, { selected }) => ({
      id: asset.id,
      position: Cartesian3.fromDegrees(asset.longitude, asset.latitude, asset.height + 25 / 2),
      cylinder: {
        length: 25,
        topRadius: 5,
        bottomRadius: 1.2,
        material: Color.fromCssColorString(TYPE_COLOR.jammer).withAlpha(0.92),
        outline: true,
        outlineColor: selected
          ? Color.WHITE
          : Color.fromCssColorString(TYPE_COLOR.jammer).brighten(0.5, new Color()),
        outlineWidth: selected ? 3 : 1,
      },
      label: labelGraphics(asset.label, selected),
    }),
  },
  sensor: {
    visualHeight: 8,
    build: (asset, { selected }) => ({
      id: asset.id,
      position: Cartesian3.fromDegrees(asset.longitude, asset.latitude, asset.height + 8 / 2),
      cylinder: {
        length: 8,
        topRadius: 7,
        bottomRadius: 0.5,
        material: Color.fromCssColorString(TYPE_COLOR.sensor).withAlpha(0.92),
        outline: true,
        outlineColor: selected
          ? Color.WHITE
          : Color.fromCssColorString(TYPE_COLOR.sensor).brighten(0.5, new Color()),
        outlineWidth: selected ? 3 : 1,
      },
      label: labelGraphics(asset.label, selected),
    }),
  },
  relay: {
    visualHeight: 35,
    build: (asset, { selected }) => ({
      id: asset.id,
      position: Cartesian3.fromDegrees(asset.longitude, asset.latitude, asset.height + 35 / 2),
      cylinder: {
        length: 35,
        topRadius: 0.6,
        bottomRadius: 0.6,
        material: Color.fromCssColorString(TYPE_COLOR.relay).withAlpha(0.92),
        outline: true,
        outlineColor: selected
          ? Color.WHITE
          : Color.fromCssColorString(TYPE_COLOR.relay).brighten(0.5, new Color()),
        outlineWidth: selected ? 3 : 1,
      },
      label: labelGraphics(asset.label, selected),
    }),
  },
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
