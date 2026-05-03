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
  COVERAGE_EFFECTIVE_ALPHA,
  COVERAGE_NOMINAL_GHOST_ALPHA,
  COVERAGE_THRESHOLD_DBM,
  COVERAGE_VOLUME_RGB,
} from './assetVisuals'
import { buildMaxJammerField, effectiveToleranceDb } from './coverageMath'

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

// "params" hash — what determines the fetched grid. Triggers a refetch
// when changed.
function paramsKeyFor(a: Asset): string {
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

// "render" hash — what determines the visualisation (params + co-channel
// jammer state). When this changes but params didn't, we rebuild the
// primitive from the cached grid without re-fetching from Sionna.
function renderKeyFor(
  a: Asset,
  allAssets: Asset[],
  coverageGrids: Record<string, CoverageGrid>,
): string {
  const base = paramsKeyFor(a)
  if (a.type === 'jammer') return base
  // Sort to keep the key stable across array order changes.
  const cochannel = allAssets
    .filter(
      (o) =>
        o.type === 'jammer'
        && Math.abs(o.frequencyMhz - a.frequencyMhz) <= 80, // FREQUENCY_MATCH_TOLERANCE_MHZ
    )
    .map((o) => `${o.id}@${coverageGrids[o.id]?.computed_at ?? 'none'}`)
    .sort()
    .join(',')
  return `${base}|cc:${cochannel}`
}

type Entry = {
  paramsKey: string
  renderKey: string
  primitive: Primitive | null
  abort: AbortController
}

export function CoverageLayer() {
  const { viewer } = useCesium()
  const assets = useStore((s) => s.assets)
  const aoi = useStore((s) => s.aoi)
  const visibleIds = useStore((s) => s.visibleCoverageIds)
  const typesVisible = useStore((s) => s.coverageTypesVisible)
  // Subscribe so the effect re-runs when a jammer's grid arrives — that's
  // what triggers the per-non-jammer "rebuild from cached grid, no refetch"
  // path below (jammer state → renderKey changes → primitive rebuilds).
  const coverageGrids = useStore((s) => s.coverageGrids)
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

    // Two-pass: (1) for each visible asset whose ONLY change is renderKey
    // (i.e. a co-channel jammer's grid arrived/changed), rebuild the
    // primitive locally from the cached grid — no network round trip;
    // (2) for assets whose paramsKey changed or that have no cached primitive,
    // queue a fresh fetch.
    const pending: Array<{ asset: Asset; entry: Entry }> = []
    for (const asset of assets) {
      if (!visibleIds.has(asset.id)) continue
      if (typesVisible[asset.type] === false) continue
      const pKey = paramsKeyFor(asset)
      const rKey = renderKeyFor(asset, assets, coverageGrids)
      const existing = cache.get(asset.id)
      if (existing && existing.paramsKey === pKey && existing.renderKey === rKey) continue

      // (1) Same fetched grid, only render context changed → rebuild locally.
      if (existing && existing.paramsKey === pKey) {
        const grid = coverageGrids[asset.id]
        if (grid) {
          const groundOffsetM = aoiTerrainHeight(viewer, grid.bbox)
          const newPrimitive = buildCoveragePrimitive(asset, grid, groundOffsetM, assets, coverageGrids)
          if (existing.primitive) viewer.scene.primitives.remove(existing.primitive)
          if (newPrimitive) viewer.scene.primitives.add(newPrimitive)
          existing.primitive = newPrimitive
          existing.renderKey = rKey
          if (!viewer.isDestroyed()) viewer.scene.requestRender()
          continue
        }
      }

      // (2) Need a fresh fetch.
      if (existing) existing.abort.abort()
      const abort = new AbortController()
      const entry: Entry = {
        paramsKey: pKey,
        renderKey: rKey,
        primitive: existing?.primitive ?? null,
        abort,
      }
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
          // Pass the LATEST store snapshot so the just-fetched grid (already
          // pushed via setCoverageGrid above) is visible to renderKeyFor /
          // buildMaxJammerField for any non-jammers in the same batch.
          const latestGrids = useStore.getState().coverageGrids
          const newPrimitive = buildCoveragePrimitive(
            asset,
            grid,
            groundOffsetM,
            assets,
            latestGrids,
          )
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
  }, [viewer, assets, aoi, visibleIds, typesVisible, coverageGrids])

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
//
// When `maxJammer` + `toleranceDb` are supplied, the potential becomes the
// MIN of (signal - threshold) and ((signal - jammer) - tolerance), so the
// rendered surface is the boundary of "covered AND not jammed" — the
// effective coverage volume after a co-channel jammer's interference.
function buildShellInstance(
  asset: Asset,
  grid: CoverageGrid,
  groundOffsetM: number,
  threshold: number,
  alpha: number,
  contourIdx: number,
  maxJammer: Float32Array | null = null,
  toleranceDb: number | null = null,
): GeometryInstance | null {
  const { values, nx, ny, nz } = grid
  const useJamMask = maxJammer != null && toleranceDb != null
  const potential = (x: number, y: number, z: number): number => {
    const i = Math.max(0, Math.min(nx - 1, Math.round(x)))
    const j = Math.max(0, Math.min(ny - 1, Math.round(y)))
    const k = Math.max(0, Math.min(nz - 1, Math.round(z)))
    const idx = i * ny * nz + j * nz + k
    const sig = values[idx]
    const p1 = sig - threshold
    if (!useJamMask) return p1
    const jam = maxJammer![idx]
    if (jam === -Infinity) return p1
    const p2 = sig - jam - (toleranceDb as number)
    return Math.min(p1, p2)
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

function buildCoveragePrimitive(
  asset: Asset,
  grid: CoverageGrid,
  groundOffsetM: number,
  allAssets: Asset[],
  coverageGrids: Record<string, CoverageGrid>,
): Primitive | null {
  const baseThreshold = COVERAGE_THRESHOLD_DBM[asset.type]
  const tolerance = effectiveToleranceDb(asset.type)
  const maxJammer =
    tolerance != null ? buildMaxJammerField(asset, grid, allAssets, coverageGrids) : null

  const instances: GeometryInstance[] = []

  if (maxJammer && tolerance != null) {
    // Non-jammer with at least one co-channel jammer cached → switch to the
    // 2-shell "ghost + effective" layout. Faded outer shell shows the volume
    // that would be covered without jamming; vivid inner shell shows what
    // actually survives the jammer's interference. The visible gap between
    // them is what was lost.
    const ghost = buildShellInstance(
      asset,
      grid,
      groundOffsetM,
      baseThreshold,
      COVERAGE_NOMINAL_GHOST_ALPHA,
      0,
    )
    if (ghost) instances.push(ghost)
    const effective = buildShellInstance(
      asset,
      grid,
      groundOffsetM,
      baseThreshold,
      COVERAGE_EFFECTIVE_ALPHA,
      1,
      maxJammer,
      tolerance,
    )
    if (effective) instances.push(effective)
    if (instances.length === 0) return null
    console.log(
      `[CoverageLayer] ${asset.label}: 2-shell render (ghost + effective under jamming)`,
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

  // Default: 3-shell nested contour rendering for jammers and for non-jammers
  // with no co-channel jamming in play. Gives the operator a topographic-style
  // strength gradient (fringe → strong → core).
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
