import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import {
  BoundingSphere,
  Cartesian3,
  Cartographic,
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
  type Viewer as CesiumViewer,
} from 'cesium'
// @ts-expect-error — isosurface ships without types.
import isosurface from 'isosurface'
import { requestCoverage, type CoverageGrid, type GridSpec } from '../api'
import { useStore } from '../store'
import type { Asset } from '../types'
import {
  COVERAGE_CONTOUR_ALPHA,
  COVERAGE_CONTOUR_OFFSETS_DB,
  COVERAGE_THRESHOLD_DBM,
  COVERAGE_VOLUME_RGB,
} from './assetVisuals'

// Default voxel grid spec: 25 m horizontal, 0–100 m vertical. Tight vertical
// range covers most drone-altitude scenarios and keeps per-request Sionna
// time bounded (4 Z slices ≈ 12-15 s, fits inside cloudflared's free-tier
// request timeout with margin even when ERP edits trigger pile-up).
const DEFAULT_VOXEL_SIZE_M = 25
const DEFAULT_HEIGHT_MIN_M = 0
const DEFAULT_HEIGHT_MAX_M = 100

// How many coverage fetches to run in parallel against the Colab tunnel.
// Colab has one GPU and cloudflared's free tier ~100 s request timeout, so
// fully parallel overloads → 502s. 2 keeps a steady pipeline of compute +
// network without contention.
const MAX_CONCURRENT_FETCHES = 2

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
  const typesVisible = useStore((s) => s.coverageTypesVisible)
  const cacheRef = useRef<Map<string, Entry>>(new Map())

  useEffect(() => {
    if (!viewer || !aoi) return

    const cache = cacheRef.current
    const liveAssetIds = new Set(assets.map((a) => a.id))

    // Evict cache ONLY for assets that no longer exist. Toggling visibility
    // doesn't drop the primitive — we just flip its `.show` flag below so
    // re-enabling is instant (no Sionna refetch).
    let removedAny = false
    for (const [id, entry] of cache.entries()) {
      if (!liveAssetIds.has(id)) {
        entry.abort.abort()
        if (entry.primitive && !viewer.isDestroyed()) {
          viewer.scene.primitives.remove(entry.primitive)
          removedAny = true
        }
        cache.delete(id)
        // Drop the grid from the simulation cache too — once an asset is
        // deleted it can no longer contribute to SJR evaluation.
        useStore.getState().removeCoverageGrid(id)
      }
    }

    // Update visibility on cached primitives.
    for (const asset of assets) {
      const entry = cache.get(asset.id)
      if (!entry || !entry.primitive) continue
      const shouldShow =
        visibleIds.has(asset.id) && typesVisible[asset.type] !== false
      if (entry.primitive.show !== shouldShow) {
        entry.primitive.show = shouldShow
        removedAny = true
      }
    }
    // requestRenderMode = true means scene only redraws when explicitly asked.
    if (removedAny && !viewer.isDestroyed()) viewer.scene.requestRender()

    // Build the list of assets that need a fresh fetch.
    const pending: Array<{ asset: Asset; entry: Entry }> = []
    for (const asset of assets) {
      if (!visibleIds.has(asset.id)) continue
      if (typesVisible[asset.type] === false) continue
      const key = coverageKey(asset)
      const existing = cache.get(asset.id)
      if (existing && existing.key === key) continue
      if (existing) existing.abort.abort()

      const abort = new AbortController()
      const entry: Entry = { key, primitive: existing?.primitive ?? null, abort }
      cache.set(asset.id, entry)
      pending.push({ asset, entry })
    }

    if (pending.length === 0) return

    // Bounded-parallel worker pool — N workers each pull from the shared
    // pending queue. Fully serial would be ~N× slower; fully parallel
    // overloads Colab + cloudflared and trips 502s.
    let cancelled = false
    let nextIdx = 0
    const gridSpec: GridSpec = {
      bbox: aoi.bbox,
      voxel_size_m: DEFAULT_VOXEL_SIZE_M,
      height_min_m: DEFAULT_HEIGHT_MIN_M,
      height_max_m: DEFAULT_HEIGHT_MAX_M,
    }

    const store = useStore.getState()

    const worker = async (workerId: number) => {
      while (!cancelled) {
        const i = nextIdx++
        if (i >= pending.length) return
        const { asset, entry } = pending[i]
        if (cache.get(asset.id) !== entry || entry.abort.signal.aborted) continue

        console.log(
          `[CoverageLayer w${workerId}] fetching coverage for ${asset.label} (${asset.type})`,
        )
        store.beginCoverageFetch()
        try {
          const grid = await requestCoverage(asset, gridSpec, entry.abort.signal)
          if (entry.abort.signal.aborted || viewer.isDestroyed()) continue

          const threshold = COVERAGE_THRESHOLD_DBM[asset.type]
          let above = 0
          let mn = Infinity
          let mx = -Infinity
          for (let j = 0; j < grid.values.length; j += 1) {
            const v = grid.values[j]
            if (v > threshold) above += 1
            if (v < mn) mn = v
            if (v > mx) mx = v
          }
          console.log(
            `[CoverageLayer] ${asset.label}: grid ${grid.nx}×${grid.ny}×${grid.nz}, range ${mn.toFixed(1)}→${mx.toFixed(1)} dBm, above ${threshold} = ${above}`,
          )

          const groundOffsetM = aoiTerrainHeight(viewer, grid.bbox)
          // Mirror the freshly-fetched grid + the AOI ground offset into the
          // store so the simulation's SJR sampler has everything it needs to
          // sample this jammer at any drone position. Only jammers actually
          // gate jamming, but mirroring all types is uniform and cheap.
          store.setCoverageGrid(asset.id, grid)
          if (useStore.getState().aoiGroundOffsetM !== groundOffsetM) {
            store.setAoiGroundOffsetM(groundOffsetM)
          }
          const newPrimitive = buildCoveragePrimitive(asset, grid, groundOffsetM)
          if (!newPrimitive) {
            console.warn(`[CoverageLayer] ${asset.label}: no isosurface generated`)
          }
          if (entry.primitive) viewer.scene.primitives.remove(entry.primitive)
          if (newPrimitive) viewer.scene.primitives.add(newPrimitive)
          entry.primitive = newPrimitive
          viewer.scene.requestRender()
        } catch (err) {
          if (!entry.abort.signal.aborted) {
            console.error(`[CoverageLayer] coverage fetch for ${asset.label} failed`, err)
          }
        } finally {
          store.endCoverageFetch()
        }
      }
    }

    const workerCount = Math.min(MAX_CONCURRENT_FETCHES, pending.length)
    void Promise.all(
      Array.from({ length: workerCount }, (_, w) => worker(w)),
    )

    return () => {
      cancelled = true
    }
  }, [viewer, assets, aoi, visibleIds, typesVisible])

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

function aoiTerrainHeight(viewer: CesiumViewer, bbox: number[]): number {
  // Sample the terrain (no 3D tilesets) at the AOI center. Used as the
  // "local z=0" reference for the coverage grid — Sionna scenes put ground
  // at local z=0, but Cesium expects ellipsoidal heights, and in regions
  // with geoid undulation (like SF, ~-25 m) those don't agree.
  const lat = (bbox[1] + bbox[3]) / 2
  const lon = (bbox[0] + bbox[2]) / 2
  const cart = Cartographic.fromDegrees(lon, lat)
  const h = viewer.scene.globe.getHeight(cart)
  return Number.isFinite(h) ? (h as number) : 0
}


// Build one GeometryInstance for a single isosurface shell at `threshold`.
// Returns null if the field has no boundary at this threshold (entire grid
// above or below).
function buildShellInstance(
  asset: Asset,
  grid: CoverageGrid,
  groundOffsetM: number,
  threshold: number,
  alpha: number,
  contourIdx: number,
): GeometryInstance | null {
  const { values, nx, ny, nz } = grid
  const potential = (x: number, y: number, z: number): number => {
    const i = Math.max(0, Math.min(nx - 1, Math.round(x)))
    const j = Math.max(0, Math.min(ny - 1, Math.round(y)))
    const k = Math.max(0, Math.min(nz - 1, Math.round(z)))
    return values[i * ny * nz + j * nz + k] - threshold
  }

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

  const centerLat = (grid.bbox[1] + grid.bbox[3]) / 2
  const degPerMLat = 1 / 111_320
  const degPerMLon = 1 / (111_320 * Math.cos((centerLat * Math.PI) / 180))
  const lonStep = grid.voxel_size_m * degPerMLon
  const latStep = grid.voxel_size_m * degPerMLat

  const vertCount = mesh.positions.length
  const positions = new Float64Array(vertCount * 3)
  for (let v = 0; v < vertCount; v += 1) {
    const [i, j, k] = mesh.positions[v]
    const lon = grid.bbox[0] + (i + 0.5) * lonStep
    const lat = grid.bbox[1] + (j + 0.5) * latStep
    const h = groundOffsetM + grid.height_min_m + (k + 0.5) * grid.voxel_size_m
    const c = Cartesian3.fromDegrees(lon, lat, h)
    positions[v * 3 + 0] = c.x
    positions[v * 3 + 1] = c.y
    positions[v * 3 + 2] = c.z
  }

  let triCount = 0
  for (const cell of mesh.cells) {
    if (cell.length === 4) triCount += 2
    else if (cell.length === 3) triCount += 1
  }
  const indices =
    vertCount > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3)
  let outIdx = 0
  for (const cell of mesh.cells) {
    if (cell.length === 4) {
      const [a, b, c, d] = cell
      indices[outIdx++] = a; indices[outIdx++] = b; indices[outIdx++] = c
      indices[outIdx++] = a; indices[outIdx++] = c; indices[outIdx++] = d
    } else if (cell.length === 3) {
      const [a, b, c] = cell
      indices[outIdx++] = a; indices[outIdx++] = b; indices[outIdx++] = c
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
  GeometryPipeline.computeNormal(geometry)

  const [r, g, b] = COVERAGE_VOLUME_RGB[asset.type]
  const color = Color.fromBytes(r, g, b, Math.round(alpha * 255))
  return new GeometryInstance({
    geometry,
    id: `coverage-${asset.id}-${contourIdx}`,
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
  })
}

function buildCoveragePrimitive(asset: Asset, grid: CoverageGrid, groundOffsetM: number): Primitive | null {
  const baseThreshold = COVERAGE_THRESHOLD_DBM[asset.type]

  // Build nested contours (fringe → strong → core). Each shell is a separate
  // GeometryInstance batched into a single Primitive — gives the operator a
  // 3D-topographic-line look so they can read signal *strength bands*, not
  // just an on/off boundary.
  const instances: GeometryInstance[] = []
  for (let i = 0; i < COVERAGE_CONTOUR_OFFSETS_DB.length; i += 1) {
    const offset = COVERAGE_CONTOUR_OFFSETS_DB[i]
    const alpha = COVERAGE_CONTOUR_ALPHA[i]
    const inst = buildShellInstance(
      asset,
      grid,
      groundOffsetM,
      baseThreshold + offset,
      alpha,
      i,
    )
    if (inst) instances.push(inst)
  }
  if (instances.length === 0) return null
  console.log(
    `[CoverageLayer] ${asset.label}: built ${instances.length} contour shells`,
  )

  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({
      flat: false,
      translucent: true,
      closed: false,
    }),
    asynchronous: false,
    releaseGeometryInstances: true,
    allowPicking: false,
  })
}
