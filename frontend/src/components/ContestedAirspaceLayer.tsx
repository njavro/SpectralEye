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
import type { CoverageGrid } from '../api'
import { useStore } from '../store'
import {
  JAMMER_CONTESTED_THRESHOLD_DBM,
  JAMMER_DOMINANCE_THRESHOLD_DBM,
} from '../types'

// Renders the "drone-jamming" volume for every cached jammer coverage grid as
// two nested isosurface shells:
//
//   outer @ JAMMER_CONTESTED_THRESHOLD_DBM  — the actual jamming boundary;
//     a default-tuned drone outside this shell stays clear of the link
//     loss. Drawn at low alpha so it doesn't dominate the scene.
//   inner @ JAMMER_DOMINANCE_THRESHOLD_DBM  — the "no-escape" core where
//     the jammer dominates with margin. Higher alpha to visually anchor
//     the jammer's true line-of-sight effective zone.
//
// Re-runs whenever a jammer is added/removed, its coverage grid arrives, or
// the user toggles `contestedAirspaceVisible` in the Situation Modeling panel.
// Builds a per-jammer Primitive that's flipped via .show on toggle so we don't
// re-marching-cubes when hiding/showing.
//
// Color: magenta (#d946ef), shell-specific alpha — distinct from jammer red,
// sensor blue, relay yellow, OoI green.

// (R, G, B, A) for the outer ("drone gets jammed here") and inner ("jammer
// dominates by ≥ 20 dB") shells. Outer must stay light enough that the inner
// shows through it.
const CONTESTED_OUTER_RGBA: [number, number, number, number] = [217, 70, 239, 35]
const CONTESTED_INNER_RGBA: [number, number, number, number] = [217, 70, 239, 110]

type Entry = {
  // Hash that decides whether the cached primitive is still valid.
  key: string
  primitive: Primitive | null
}

function jammerKey(assetId: string, grid: CoverageGrid, groundOffsetM: number): string {
  return [
    assetId,
    grid.computed_at,
    grid.nx,
    grid.ny,
    grid.nz,
    grid.voxel_size_m,
    groundOffsetM.toFixed(2),
  ].join('|')
}

export function ContestedAirspaceLayer() {
  const { viewer } = useCesium()
  const visible = useStore((s) => s.contestedAirspaceVisible)
  const assets = useStore((s) => s.assets)
  const coverageGrids = useStore((s) => s.coverageGrids)
  const groundOffsetM = useStore((s) => s.aoiGroundOffsetM)
  const cacheRef = useRef<Map<string, Entry>>(new Map())

  useEffect(() => {
    if (!viewer) return

    const cache = cacheRef.current
    const jammers = assets.filter((a) => a.type === 'jammer')
    const liveJammerIds = new Set(jammers.map((j) => j.id))
    const offset = groundOffsetM ?? 0

    // Drop primitives for jammers that no longer exist.
    let changed = false
    for (const [id, entry] of cache.entries()) {
      if (!liveJammerIds.has(id)) {
        if (entry.primitive && !viewer.isDestroyed()) {
          viewer.scene.primitives.remove(entry.primitive)
          changed = true
        }
        cache.delete(id)
      }
    }

    // Visibility-only path: just flip .show without rebuilding meshes.
    for (const entry of cache.values()) {
      if (entry.primitive && entry.primitive.show !== visible) {
        entry.primitive.show = visible
        changed = true
      }
    }

    // Build / rebuild meshes for jammers whose grid is fresh or new.
    if (visible) {
      for (const jammer of jammers) {
        const grid = coverageGrids[jammer.id]
        if (!grid) continue
        const key = jammerKey(jammer.id, grid, offset)
        const existing = cache.get(jammer.id)
        if (existing && existing.key === key) continue

        if (existing?.primitive && !viewer.isDestroyed()) {
          viewer.scene.primitives.remove(existing.primitive)
        }
        const newPrimitive = buildContestedPrimitive(grid, offset)
        if (newPrimitive) {
          viewer.scene.primitives.add(newPrimitive)
          cache.set(jammer.id, { key, primitive: newPrimitive })
          changed = true
        } else {
          // No isosurface at this threshold for this jammer (signal never
          // crosses -65 dBm anywhere in the grid). Cache the empty result so
          // we don't retry every render.
          cache.set(jammer.id, { key, primitive: null })
        }
      }
    }

    if (changed && !viewer.isDestroyed()) viewer.scene.requestRender()
  }, [viewer, visible, assets, coverageGrids, groundOffsetM])

  // Clear all primitives on unmount.
  useEffect(() => {
    return () => {
      const cache = cacheRef.current
      if (viewer && !viewer.isDestroyed()) {
        for (const entry of cache.values()) {
          if (entry.primitive) viewer.scene.primitives.remove(entry.primitive)
        }
      }
      cache.clear()
    }
  }, [viewer])

  return null
}

function buildShellInstance(
  grid: CoverageGrid,
  groundOffsetM: number,
  threshold: number,
  rgba: [number, number, number, number],
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

  const [r, g, b, a] = rgba
  return new GeometryInstance({
    geometry,
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromBytes(r, g, b, a)) },
  })
}

function buildContestedPrimitive(grid: CoverageGrid, groundOffsetM: number): Primitive | null {
  // Build outer first (matching simulation jamming boundary), then inner
  // (dominance core). Either may be null if the field never crosses the
  // threshold inside the grid; primitive is null only if BOTH are missing.
  const instances: GeometryInstance[] = []
  const outer = buildShellInstance(
    grid,
    groundOffsetM,
    JAMMER_CONTESTED_THRESHOLD_DBM,
    CONTESTED_OUTER_RGBA,
  )
  if (outer) instances.push(outer)
  const inner = buildShellInstance(
    grid,
    groundOffsetM,
    JAMMER_DOMINANCE_THRESHOLD_DBM,
    CONTESTED_INNER_RGBA,
  )
  if (inner) instances.push(inner)
  if (instances.length === 0) return null

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
