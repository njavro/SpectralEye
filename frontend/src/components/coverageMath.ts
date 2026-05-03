// Pure jamming-aware coverage math. Used by CoverageLayer (to render the
// effective shell that shrinks when co-channel jammers are present) and by
// AssetDetailPanel (to compute the "% nominal coverage retained" badge).
// Side-effect-free, no Cesium / store imports.

import type { CoverageGrid } from '../api'
import {
  FREQUENCY_MATCH_TOLERANCE_MHZ,
  RELAY_SJR_MARGIN_DB,
  SENSOR_SNR_MARGIN_DB,
} from '../types'
import type { Asset, AssetType } from '../types'

// Per-asset tolerance — how many dB the asset's signal must exceed the
// strongest co-channel jammer for the voxel to still count as covered.
// Returns null for jammers (they aren't degraded by other jammers in this
// model — concurrent jamming is treated as additive noise, not interference).
export function effectiveToleranceDb(type: AssetType): number | null {
  switch (type) {
    case 'relay':
      return RELAY_SJR_MARGIN_DB
    case 'sensor':
      return SENSOR_SNR_MARGIN_DB
    case 'jammer':
      return null
  }
}

// Build a per-voxel max-jammer field over the same grid as `referenceGrid`,
// taking the strongest co-channel jammer at each voxel. Returns null if no
// co-channel jammer has a cached grid, in which case the caller should skip
// effective-coverage computation entirely (no jamming → no shrinkage).
//
// Co-channel = within FREQUENCY_MATCH_TOLERANCE_MHZ. Jammer grids that
// don't match the reference grid's dimensions are skipped (defensive — would
// happen if a stale grid lingered after the AOI changed).
export function buildMaxJammerField(
  asset: Asset,
  referenceGrid: CoverageGrid,
  assets: Asset[],
  coverageGrids: Record<string, CoverageGrid>,
): Float32Array | null {
  const matchingJammers: CoverageGrid[] = []
  for (const a of assets) {
    if (a.type !== 'jammer') continue
    if (a.id === asset.id) continue
    if (Math.abs(a.frequencyMhz - asset.frequencyMhz) > FREQUENCY_MATCH_TOLERANCE_MHZ) continue
    const g = coverageGrids[a.id]
    if (!g) continue
    if (g.nx !== referenceGrid.nx || g.ny !== referenceGrid.ny || g.nz !== referenceGrid.nz) continue
    matchingJammers.push(g)
  }
  if (matchingJammers.length === 0) return null

  const len = referenceGrid.values.length
  const out = new Float32Array(len)
  // Initialize to -Infinity so the first jammer's values become the running max.
  out.fill(-Infinity)
  for (const g of matchingJammers) {
    for (let i = 0; i < len; i += 1) {
      const v = g.values[i]
      if (v > out[i]) out[i] = v
    }
  }
  return out
}

// Count voxels that satisfy the asset's nominal threshold AND (when supplied)
// the SJR/SNR margin against the strongest jammer. Used for the retention
// ratio. O(N) over the grid.
function countVoxels(
  grid: CoverageGrid,
  threshold: number,
  maxJammer: Float32Array | null,
  toleranceDb: number | null,
): number {
  let n = 0
  const len = grid.values.length
  for (let i = 0; i < len; i += 1) {
    const sig = grid.values[i]
    if (sig <= threshold) continue
    if (maxJammer != null && toleranceDb != null) {
      const jam = maxJammer[i]
      if (jam !== -Infinity && sig - jam <= toleranceDb) continue
    }
    n += 1
  }
  return n
}

export type CoverageRetention = {
  // Voxel counts at the asset's base threshold.
  nominal: number
  effective: number
  // effective / nominal in [0, 1]; 1.0 = no degradation, 0 = fully jammed.
  ratio: number
  // True iff a co-channel jammer with a cached grid actually exists; tells
  // the UI whether to show the retention badge at all (no jammer → no point).
  hasJammer: boolean
}

// Compute the retention ratio for a non-jammer asset given the current set
// of cached jammer grids. Returns null for jammers themselves and for assets
// whose own coverage grid hasn't been cached yet.
export function computeRetention(
  asset: Asset,
  coverageGrids: Record<string, CoverageGrid>,
  assets: Asset[],
  baseThresholdDbm: number,
): CoverageRetention | null {
  const tolerance = effectiveToleranceDb(asset.type)
  if (tolerance == null) return null
  const grid = coverageGrids[asset.id]
  if (!grid) return null

  const maxJammer = buildMaxJammerField(asset, grid, assets, coverageGrids)
  const nominal = countVoxels(grid, baseThresholdDbm, null, null)
  const effective =
    maxJammer == null ? nominal : countVoxels(grid, baseThresholdDbm, maxJammer, tolerance)
  return {
    nominal,
    effective,
    ratio: nominal === 0 ? 1 : effective / nominal,
    hasJammer: maxJammer != null,
  }
}
