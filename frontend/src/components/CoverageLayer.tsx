import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import {
  BoundingSphere,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  GeometryPipeline,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveType,
} from 'cesium'
// @ts-expect-error — isosurface ships without types.
import isosurface from 'isosurface'
import { requestCoverage, type CoverageGrid, type GridSpec } from '../api'
import { useStore } from '../store'
import type { Asset } from '../types'
import { COVERAGE_THRESHOLD_DBM, COVERAGE_VOLUME_RGBA } from './assetVisuals'

// Default voxel grid spec: 25 m horizontal, 0–500 m vertical. Matches what
// the user OK'd on Phase 4 kickoff.
const DEFAULT_VOXEL_SIZE_M = 25
const DEFAULT_HEIGHT_MIN_M = 0
const DEFAULT_HEIGHT_MAX_M = 500

// A "coverage params" hash — only re-fetch when something material changes.
function coverageKey(a: Asset): string {
  return [
    a.id,
    a.type,
    a.longitude.toFixed(6),
    a.latitude.toFixed(6),
    a.height.toFixed(2),
    a.frequencyMhz,
    a.erpDbm,
    a.antennaPattern,
  ].join('|')
}

type Entry = {
  key: string
  primitive: Primitive | null
  abort: AbortController
}

export function CoverageLayer() {
  const { viewer } = useCesium()
  const assets = useStore((s) => s.assets)
  const aoi = useStore((s) => s.aoi)
  const visibleIds = useStore((s) => s.visibleCoverageIds)
  const cacheRef = useRef<Map<string, Entry>>(new Map())

  useEffect(() => {
    if (!viewer || !aoi) return

    const cache = cacheRef.current
    const visibleAssetIds = new Set(
      assets.filter((a) => visibleIds.has(a.id)).map((a) => a.id),
    )

    // Drop primitives for assets that are no longer visible (deleted OR hidden).
    let removedAny = false
    for (const [id, entry] of cache.entries()) {
      if (!visibleAssetIds.has(id)) {
        entry.abort.abort()
        if (entry.primitive && !viewer.isDestroyed()) {
          viewer.scene.primitives.remove(entry.primitive)
          removedAny = true
        }
        cache.delete(id)
      }
    }
    // requestRenderMode = true means scene only redraws when explicitly asked;
    // primitive removal alone doesn't trigger it.
    if (removedAny && !viewer.isDestroyed()) viewer.scene.requestRender()

    // For each VISIBLE asset, refresh if params changed.
    for (const asset of assets) {
      if (!visibleIds.has(asset.id)) continue
      const key = coverageKey(asset)
      const existing = cache.get(asset.id)
      if (existing && existing.key === key) continue

      // Cancel any pending request for this asset.
      if (existing) existing.abort.abort()

      const abort = new AbortController()
      const entry: Entry = { key, primitive: existing?.primitive ?? null, abort }
      cache.set(asset.id, entry)

      const gridSpec: GridSpec = {
        bbox: aoi.bbox,
        voxel_size_m: DEFAULT_VOXEL_SIZE_M,
        height_min_m: DEFAULT_HEIGHT_MIN_M,
        height_max_m: DEFAULT_HEIGHT_MAX_M,
      }

      console.log(`[CoverageLayer] fetching coverage for ${asset.label} (${asset.type})`)
      void requestCoverage(asset, gridSpec, abort.signal)
        .then((grid) => {
          if (abort.signal.aborted || viewer.isDestroyed()) return
          // Sanity check: how much of the grid is above threshold?
          const threshold = COVERAGE_THRESHOLD_DBM[asset.type]
          let above = 0
          let below = 0
          let mn = Infinity
          let mx = -Infinity
          for (let i = 0; i < grid.values.length; i += 1) {
            const v = grid.values[i]
            if (v > threshold) above += 1
            else below += 1
            if (v < mn) mn = v
            if (v > mx) mx = v
          }
          console.log(
            `[CoverageLayer] ${asset.label}: grid ${grid.nx}×${grid.ny}×${grid.nz} = ${grid.values.length} voxels, range ${mn.toFixed(1)}→${mx.toFixed(1)} dBm, above threshold ${threshold} = ${above} (${((above / grid.values.length) * 100).toFixed(1)}%), below = ${below}`,
          )
          if (above === 0) {
            console.warn(`[CoverageLayer] ${asset.label}: no voxels above threshold — no volume to render`)
          } else if (below === 0) {
            console.warn(`[CoverageLayer] ${asset.label}: ALL voxels above threshold — coverage exceeds AOI, marching cubes finds no boundary`)
          }
          const newPrimitive = buildCoveragePrimitive(asset, grid)
          if (!newPrimitive) {
            console.warn(`[CoverageLayer] ${asset.label}: no isosurface generated`)
          } else {
            console.log(`[CoverageLayer] ${asset.label}: coverage primitive added`)
          }
          if (entry.primitive) viewer.scene.primitives.remove(entry.primitive)
          if (newPrimitive) viewer.scene.primitives.add(newPrimitive)
          entry.primitive = newPrimitive
          viewer.scene.requestRender()
        })
        .catch((err) => {
          if (abort.signal.aborted) return
          console.error(`[CoverageLayer] coverage fetch for ${asset.label} failed`, err)
        })
    }
  }, [viewer, assets, aoi, visibleIds])

  // Cleanup on unmount: cancel pending requests + drop primitives.
  useEffect(() => {
    return () => {
      const cache = cacheRef.current
      for (const entry of cache.values()) {
        entry.abort.abort()
        if (entry.primitive && viewer && !viewer.isDestroyed()) {
          viewer.scene.primitives.remove(entry.primitive)
        }
      }
      cache.clear()
    }
  }, [viewer])

  return null
}

// ---------------------------------------------------------------------------
// Marching cubes + Cesium primitive construction
// ---------------------------------------------------------------------------

function buildCoveragePrimitive(asset: Asset, grid: CoverageGrid): Primitive | null {
  const threshold = COVERAGE_THRESHOLD_DBM[asset.type]
  const { values, nx, ny, nz } = grid

  // Potential function for marching cubes — value > 0 inside the volume.
  const potential = (x: number, y: number, z: number): number => {
    const i = Math.max(0, Math.min(nx - 1, Math.round(x)))
    const j = Math.max(0, Math.min(ny - 1, Math.round(y)))
    const k = Math.max(0, Math.min(nz - 1, Math.round(z)))
    return values[i * ny * nz + j * nz + k] - threshold
  }

  // surfaceNets gives smoother volumes than marchingCubes — better for RF coverage
  // visuals where sharp cube-edges look unphysical.
  const mesh = isosurface.surfaceNets(
    [nx, ny, nz],
    potential,
    [
      [0, 0, 0],
      [nx - 1, ny - 1, nz - 1],
    ],
  ) as { positions: number[][]; cells: number[][] }

  if (!mesh.positions || mesh.positions.length === 0 || mesh.cells.length === 0) {
    return null
  }

  // Map each (i, j, k) voxel coordinate → (lon, lat, height) → Cartesian3 ECEF.
  const centerLat = (grid.bbox[1] + grid.bbox[3]) / 2
  const degPerMLat = 1 / 111_320
  const degPerMLon = 1 / (111_320 * Math.cos((centerLat * Math.PI) / 180))
  const lonStep = grid.voxel_size_m * degPerMLon
  const latStep = grid.voxel_size_m * degPerMLat

  const vertCount = mesh.positions.length
  const positions = new Float64Array(vertCount * 3)
  let minLon = Infinity, maxLon = -Infinity
  let minLat = Infinity, maxLat = -Infinity
  let minH = Infinity, maxH = -Infinity
  for (let v = 0; v < vertCount; v += 1) {
    const [i, j, k] = mesh.positions[v]
    const lon = grid.bbox[0] + (i + 0.5) * lonStep
    const lat = grid.bbox[1] + (j + 0.5) * latStep
    const h = grid.height_min_m + (k + 0.5) * grid.voxel_size_m
    const c = Cartesian3.fromDegrees(lon, lat, h)
    positions[v * 3 + 0] = c.x
    positions[v * 3 + 1] = c.y
    positions[v * 3 + 2] = c.z
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (h < minH) minH = h
    if (h > maxH) maxH = h
  }
  console.log(
    `[CoverageLayer] ${asset.label}: asset @ (${asset.longitude.toFixed(5)}, ${asset.latitude.toFixed(5)}, ${asset.height.toFixed(1)}m) — mesh bounds: lon[${minLon.toFixed(5)}, ${maxLon.toFixed(5)}] lat[${minLat.toFixed(5)}, ${maxLat.toFixed(5)}] h[${minH.toFixed(1)}, ${maxH.toFixed(1)}m] (${vertCount} verts)`,
  )

  // surfaceNets *can* emit quads OR triangles depending on version. Detect and
  // triangulate accordingly. Count exact triangle output first so the index
  // buffer isn't oversized (oversized buffer + leftover zeros = degenerate
  // triangles on vertex 0 that look like rays radiating from one point).
  let triCount = 0
  for (const cell of mesh.cells) {
    if (cell.length === 4) triCount += 2
    else if (cell.length === 3) triCount += 1
  }
  console.log(
    `[CoverageLayer] ${asset.label}: ${mesh.cells.length} cells (sample: ${mesh.cells[0]?.length} verts/cell), → ${triCount} triangles`,
  )

  const indices =
    vertCount > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3)
  let outIdx = 0
  for (const cell of mesh.cells) {
    if (cell.length === 4) {
      const [a, b, c, d] = cell
      indices[outIdx++] = a
      indices[outIdx++] = b
      indices[outIdx++] = c
      indices[outIdx++] = a
      indices[outIdx++] = c
      indices[outIdx++] = d
    } else if (cell.length === 3) {
      const [a, b, c] = cell
      indices[outIdx++] = a
      indices[outIdx++] = b
      indices[outIdx++] = c
    }
  }

  const attrs = new GeometryAttributes()
  attrs.position = new GeometryAttribute({
    componentDatatype: ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: positions,
  })

  const geometry = new Geometry({
    attributes: attrs,
    indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(positions),
  })
  // Cesium's primitive pipeline compresses position+normal+color into a single
  // packed attribute; without normal the compression step fails. Compute them.
  GeometryPipeline.computeNormal(geometry)

  const color = parseColor(COVERAGE_VOLUME_RGBA[asset.type])
  const instance = new GeometryInstance({
    geometry,
    id: `coverage-${asset.id}`,
    attributes: {
      color: ColorGeometryInstanceAttribute.fromColor(color),
    },
  })

  // flat: false uses the computed normals for subtle shading on the volume.
  const appearance = new PerInstanceColorAppearance({
    flat: false,
    translucent: true,
    closed: false,
  })

  return new Primitive({
    geometryInstances: [instance],
    appearance,
    asynchronous: false,
    releaseGeometryInstances: true,
    // Coverage volumes are visualization-only; clicks should fall through to
    // the asset cylinder primitives underneath so selection still works.
    allowPicking: false,
  })
}

function parseColor(rgba: string): Color {
  return Color.fromCssColorString(rgba)
}
