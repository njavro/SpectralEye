// Pure simulation math used by SimulationRunner each tick. Kept side-effect-
// free (no Cesium, no zustand) so it's easy to reason about and unit-test.

import type { CoverageGrid } from '../api'
import type {
  Asset,
  Drone,
  ObjectOfInterest,
  Waypoint,
} from '../types'
import {
  DRONE_LINK_REFERENCE_DBM,
  FREQUENCY_MATCH_TOLERANCE_MHZ,
} from '../types'

const M_PER_DEG_LAT = 111_320

function metersPerDegLon(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180)
}

// Local-Cartesian distance — small-AOI flat-earth approximation. AOI is bounded
// at ~5 km; over that distance the approximation error is well under 0.1%.
function distMeters(a: Waypoint, b: Waypoint): number {
  const midLat = (a.latitude + b.latitude) / 2
  const dLat = (b.latitude - a.latitude) * M_PER_DEG_LAT
  const dLon = (b.longitude - a.longitude) * metersPerDegLon(midLat)
  const dH = b.height - a.height
  return Math.sqrt(dLat * dLat + dLon * dLon + dH * dH)
}

function lerp(a: Waypoint, b: Waypoint, t: number): Waypoint {
  return {
    longitude: a.longitude + (b.longitude - a.longitude) * t,
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    height: a.height + (b.height - a.height) * t,
  }
}

export type DronePathResult = {
  position: Waypoint
  finished: boolean
}

// Walk the drone along its path at speedMps for elapsedSeconds. Returns the
// interpolated position and whether the drone has reached the end.
export function computeDronePosition(drone: Drone, elapsedSeconds: number): DronePathResult {
  const path: Waypoint[] = [drone.start, ...drone.waypoints]
  if (path.length < 2 || elapsedSeconds <= 0) {
    return { position: { ...drone.start }, finished: path.length < 2 }
  }
  let remainingDistance = elapsedSeconds * drone.speedMps
  for (let i = 0; i < path.length - 1; i += 1) {
    const segLen = distMeters(path[i], path[i + 1])
    if (segLen <= 0) continue
    if (remainingDistance <= segLen) {
      return { position: lerp(path[i], path[i + 1], remainingDistance / segLen), finished: false }
    }
    remainingDistance -= segLen
  }
  return { position: { ...path[path.length - 1] }, finished: true }
}

export function pathTotalLengthMeters(drone: Drone): number {
  const path: Waypoint[] = [drone.start, ...drone.waypoints]
  let total = 0
  for (let i = 0; i < path.length - 1; i += 1) total += distMeters(path[i], path[i + 1])
  return total
}

// ---------------------------------------------------------------------------
// Intrusion (Phase 6C)
// ---------------------------------------------------------------------------

// Returns the OoI being breached (closest one, if any), else null. Uses the
// 3D dome geometry: an OoI's "perimeter" is a hemisphere of `perimeterRadiusM`
// centered at (lon, lat, height) — drone is intruding when it sits inside that
// dome AND at or above the OoI's ground level.
export function detectIntrusion(
  drone: Waypoint,
  ois: ObjectOfInterest[],
): ObjectOfInterest | null {
  let closest: ObjectOfInterest | null = null
  let closestDist = Infinity
  for (const ooi of ois) {
    if (drone.height < ooi.height) continue
    const horizDLat = (drone.latitude - ooi.latitude) * M_PER_DEG_LAT
    const horizDLon = (drone.longitude - ooi.longitude) * metersPerDegLon(ooi.latitude)
    const dH = drone.height - ooi.height
    const d3 = Math.sqrt(horizDLat * horizDLat + horizDLon * horizDLon + dH * dH)
    if (d3 <= ooi.perimeterRadiusM && d3 < closestDist) {
      closestDist = d3
      closest = ooi
    }
  }
  return closest
}

// ---------------------------------------------------------------------------
// SJR jamming (Phase 6D)
// ---------------------------------------------------------------------------

// Sample a coverage grid at a geographic position. Returns the path-loss value
// in dBm at the nearest voxel, or null if the position lies outside the grid.
//
// `groundOffsetM` is the WGS84 ellipsoidal height of the local Sionna ground
// plane (z=0) at the AOI center — needed because the drone's `height` is
// ellipsoidal but the grid's k axis is in local-frame meters above ground.
export function sampleCoverageAt(
  grid: CoverageGrid,
  lon: number,
  lat: number,
  ellipsoidalHeightM: number,
  groundOffsetM: number,
): number | null {
  const [west, south, east, north] = grid.bbox
  if (lon < west || lon > east || lat < south || lat > north) return null

  const lonStepDeg = (east - west) / grid.nx
  const latStepDeg = (north - south) / grid.ny
  const i = Math.min(grid.nx - 1, Math.max(0, Math.floor((lon - west) / lonStepDeg)))
  const j = Math.min(grid.ny - 1, Math.max(0, Math.floor((lat - south) / latStepDeg)))

  const localZ = ellipsoidalHeightM - groundOffsetM
  const k = Math.floor((localZ - grid.height_min_m) / grid.voxel_size_m)
  if (k < 0 || k >= grid.nz) return null

  return grid.values[i * grid.ny * grid.nz + j * grid.nz + k]
}

export type JammingResult = {
  // Asset id of the strongest co-channel jammer that produced detectable
  // signal at the drone — null when no jammer's coverage grid is loaded
  // or the drone sits outside every jammer's grid.
  strongestJammerId: string | null
  jammerSignalDbm: number | null
  sjrDb: number | null
  // True iff the strongest jammer's signal exceeds the drone's threshold.
  jammed: boolean
}

// Evaluate jamming on a drone. Considers only jammer-type assets, and only
// those whose coverage has been computed (their grid lives in coverageGrids).
// SJR = DRONE_LINK_REFERENCE_DBM - jammer_dbm. A drone is jammed when SJR
// drops below its `sjrThresholdDb`.
export function evaluateJamming(
  drone: Drone,
  position: Waypoint,
  assets: Asset[],
  coverageGrids: Record<string, CoverageGrid>,
  groundOffsetM: number,
): JammingResult {
  let strongestId: string | null = null
  let strongestDbm = -Infinity

  for (const asset of assets) {
    if (asset.type !== 'jammer') continue
    if (Math.abs(asset.frequencyMhz - drone.frequencyMhz) > FREQUENCY_MATCH_TOLERANCE_MHZ) continue
    const grid = coverageGrids[asset.id]
    if (!grid) continue
    const dbm = sampleCoverageAt(grid, position.longitude, position.latitude, position.height, groundOffsetM)
    if (dbm == null || !Number.isFinite(dbm)) continue
    if (dbm > strongestDbm) {
      strongestDbm = dbm
      strongestId = asset.id
    }
  }

  if (strongestId == null) {
    return { strongestJammerId: null, jammerSignalDbm: null, sjrDb: null, jammed: false }
  }
  const sjr = DRONE_LINK_REFERENCE_DBM - strongestDbm
  return {
    strongestJammerId: strongestId,
    jammerSignalDbm: strongestDbm,
    sjrDb: sjr,
    jammed: sjr < drone.sjrThresholdDb,
  }
}
