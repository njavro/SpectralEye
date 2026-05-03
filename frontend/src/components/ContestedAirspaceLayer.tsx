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
import type { CoverageGrid } from '../api'
import { useStore } from '../store'
import { JAMMER_CONTESTED_THRESHOLD_DBM } from '../types'

// Renders the "drone-jamming" volume for every cached jammer coverage grid as
// a FILLED voxel cloud — every grid cell where the jammer signal exceeds
// JAMMER_CONTESTED_THRESHOLD_DBM becomes a small magenta cube. Unlike a
// marching-cubes isosurface (which renders only the boundary shell, leaving
// an empty interior), this fills the volume so it looks solid from any
// camera angle. Critical for demos: a drone flying near the jammer no longer
// appears to be in an "empty gap" inside an invisible bubble.
//
// The volume IS the simulation's truth: inside any visible cube → drone
// gets jammed. Outside all cubes → drone flies clear. No interpretation.
//
// Re-runs whenever a jammer is added/removed, its coverage grid arrives, or
// the user toggles `contestedAirspaceVisible` in the Situation Modeling panel.
// Builds a per-jammer Primitive that's flipped via .show on toggle so we
// don't re-voxelize when hiding/showing.

const CONTESTED_RGBA: [number, number, number, number] = [217, 70, 239, 110]

type Entry = {
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

    for (const entry of cache.values()) {
      if (entry.primitive && entry.primitive.show !== visible) {
        entry.primitive.show = visible
        changed = true
      }
    }

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
        const newPrimitive = buildVoxelFillPrimitive(grid, offset)
        if (newPrimitive) {
          viewer.scene.primitives.add(newPrimitive)
          cache.set(jammer.id, { key, primitive: newPrimitive })
          changed = true
        } else {
          cache.set(jammer.id, { key, primitive: null })
        }
      }
    }

    if (changed && !viewer.isDestroyed()) viewer.scene.requestRender()
  }, [viewer, visible, assets, coverageGrids, groundOffsetM])

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

// Build a single Geometry containing N small box meshes — one per voxel
// where the jammer's signal exceeds the contested threshold. All vertices
// concatenated into one buffer so the whole volume renders as a single
// draw call.
//
// Each box is sized to fill its voxel exactly, so adjacent contested voxels
// abut with no gaps. The result reads as a solid 3D mass from every angle.
function buildVoxelFillPrimitive(grid: CoverageGrid, groundOffsetM: number): Primitive | null {
  const { values, nx, ny, nz, voxel_size_m: vox } = grid
  const threshold = JAMMER_CONTESTED_THRESHOLD_DBM

  // First pass: collect contested voxel indices.
  const cellsLon: number[] = []
  const cellsLat: number[] = []
  const cellsAlt: number[] = []
  const centerLat = (grid.bbox[1] + grid.bbox[3]) / 2
  const degPerMLat = 1 / 111_320
  const degPerMLon = 1 / (111_320 * Math.cos((centerLat * Math.PI) / 180))
  const lonStep = vox * degPerMLon
  const latStep = vox * degPerMLat

  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let k = 0; k < nz; k += 1) {
        const sig = values[i * ny * nz + j * nz + k]
        if (sig <= threshold) continue
        cellsLon.push(grid.bbox[0] + (i + 0.5) * lonStep)
        cellsLat.push(grid.bbox[1] + (j + 0.5) * latStep)
        cellsAlt.push(groundOffsetM + grid.height_min_m + (k + 0.5) * vox)
      }
    }
  }
  const n = cellsLon.length
  if (n === 0) return null

  // Second pass: build geometry. 8 vertices per voxel × 3 (xyz) doubles.
  // 12 triangles per voxel × 3 indices.
  const halfLon = lonStep * 0.5
  const halfLat = latStep * 0.5
  const halfAlt = vox * 0.5
  const vertCount = n * 8
  const positions = new Float64Array(vertCount * 3)
  const indices =
    vertCount > 65535 ? new Uint32Array(n * 36) : new Uint16Array(n * 36)

  // Cube corner offsets in (lon, lat, alt) space relative to voxel center.
  // Order: 0:--- 1:+-- 2:++- 3:-+- 4:--+ 5:+-+ 6:+++ 7:-++  (z = altitude)
  const cornerOffs: ReadonlyArray<[number, number, number]> = [
    [-halfLon, -halfLat, -halfAlt],
    [halfLon, -halfLat, -halfAlt],
    [halfLon, halfLat, -halfAlt],
    [-halfLon, halfLat, -halfAlt],
    [-halfLon, -halfLat, halfAlt],
    [halfLon, -halfLat, halfAlt],
    [halfLon, halfLat, halfAlt],
    [-halfLon, halfLat, halfAlt],
  ]
  // 12 triangles forming a closed box, CCW when viewed from outside.
  const cubeTris: ReadonlyArray<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], // bottom (-Z)
    [4, 5, 6], [4, 6, 7], // top (+Z)
    [0, 1, 5], [0, 5, 4], // front (-Y)
    [2, 3, 7], [2, 7, 6], // back (+Y)
    [1, 2, 6], [1, 6, 5], // right (+X)
    [3, 0, 4], [3, 4, 7], // left (-X)
  ]

  for (let c = 0; c < n; c += 1) {
    const lon = cellsLon[c]
    const lat = cellsLat[c]
    const alt = cellsAlt[c]
    const vBase = c * 8
    for (let q = 0; q < 8; q += 1) {
      const [dLon, dLat, dAlt] = cornerOffs[q]
      const cart = Cartesian3.fromDegrees(lon + dLon, lat + dLat, alt + dAlt)
      const pIdx = (vBase + q) * 3
      positions[pIdx + 0] = cart.x
      positions[pIdx + 1] = cart.y
      positions[pIdx + 2] = cart.z
    }
    const iBase = c * 36
    for (let t = 0; t < 12; t += 1) {
      const tri = cubeTris[t]
      indices[iBase + t * 3 + 0] = vBase + tri[0]
      indices[iBase + t * 3 + 1] = vBase + tri[1]
      indices[iBase + t * 3 + 2] = vBase + tri[2]
    }
  }

  console.log(
    `[ContestedAirspace] ${n} contested voxels of ${nx * ny * nz} → ${(n * 12).toLocaleString()} triangles`,
  )

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

  const [r, g, b, a] = CONTESTED_RGBA
  const instance = new GeometryInstance({
    geometry,
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromBytes(r, g, b, a)) },
  })

  return new Primitive({
    geometryInstances: [instance],
    appearance: new PerInstanceColorAppearance({
      flat: false,
      translucent: true,
      closed: true, // proper closed solids — depth/back-face handling is consistent
    }),
    asynchronous: false,
    releaseGeometryInstances: true,
    allowPicking: false,
  })
}
