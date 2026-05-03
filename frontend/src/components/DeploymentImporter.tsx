import { useEffect } from 'react'
import { useCesium } from 'resium'
import { Cartographic, Math as CesiumMath } from 'cesium'
import { useStore } from '../store'
import type { AssetReport } from '../api'
import type { AssetType } from '../types'
import { isInWater, requiresLand } from './placementRules'

// Picks up self-reported deployment data from the store, snaps each report's
// position to the nearest pre-computed land sample (so we never place on water),
// then samples the actual surface height at the chosen position so the asset
// rests on whatever's there (terrain or rooftop).
export function DeploymentImporter() {
  const { viewer } = useCesium()
  const pending = useStore((s) => s.pendingDeploymentReports)

  useEffect(() => {
    if (!viewer || !pending || pending.length === 0) return

    let cancelled = false
    void importReports(viewer, pending).then(() => {
      if (cancelled) return
      const store = useStore.getState()
      store.setPendingDeploymentReports(null)
      store.setImportingDeployment(false)
    })

    return () => {
      cancelled = true
    }
  }, [viewer, pending])

  return null
}

// For relays, after snapping to nearest land, also probe a wider radius to find
// elevated terrain (hilltops/ridges). Other types stay close to the snap point.
const ELEVATION_PROBE_RADIUS_M: Record<AssetType, number> = {
  jammer: 50,
  sensor: 50,
  relay: 500,
}

function offsetLatLon(lat: number, lon: number, dxMeters: number, dyMeters: number) {
  const dLat = dyMeters / 111_320
  const dLon = dxMeters / (111_320 * Math.cos((lat * Math.PI) / 180))
  return { lat: lat + dLat, lon: lon + dLon }
}

// Find the land sample closest to the reported position. If `landSamples` is
// empty (water-fetch failed or AOI is all water somehow), returns the original
// reported position so the asset still gets placed.
function snapToLand(
  lon: number,
  lat: number,
  landSamples: Array<[number, number]>,
): [number, number] {
  if (landSamples.length === 0) return [lon, lat]
  // Squared-distance in degree space; close enough for nearest-neighbor at AOI scale.
  let best = landSamples[0]
  let bestD2 = Infinity
  for (const sample of landSamples) {
    const dlon = sample[0] - lon
    const dlat = sample[1] - lat
    const d2 = dlon * dlon + dlat * dlat
    if (d2 < bestD2) {
      bestD2 = d2
      best = sample
    }
  }
  return best
}

// Build a small ring of probe positions around (lon, lat) at the given radius
// for finding nearby elevated terrain. Used after snapToLand for relays.
function elevationProbes(
  lon: number,
  lat: number,
  radiusM: number,
): Array<[number, number]> {
  const points: Array<[number, number]> = [[lon, lat]]
  const ringCount = radiusM > 100 ? 12 : 6
  for (let i = 0; i < ringCount; i += 1) {
    const a = (i / ringCount) * 2 * Math.PI
    const p = offsetLatLon(lat, lon, radiusM * Math.cos(a), radiusM * Math.sin(a))
    points.push([p.lon, p.lat])
  }
  if (radiusM > 100) {
    // Inner ring at half radius.
    for (let i = 0; i < ringCount; i += 1) {
      const a = (i / ringCount) * 2 * Math.PI
      const p = offsetLatLon(lat, lon, (radiusM / 2) * Math.cos(a), (radiusM / 2) * Math.sin(a))
      points.push([p.lon, p.lat])
    }
  }
  return points
}

async function importReports(
  viewer: NonNullable<ReturnType<typeof useCesium>['viewer']>,
  reports: AssetReport[],
) {
  const store = useStore.getState()
  const landSamples = store.landSamples ?? []
  const waterPolygons = store.waterPolygons ?? []
  console.log(
    `[DeploymentImporter] land samples available: ${landSamples.length}${
      landSamples.length === 0 ? ' (no water-aware snapping)' : ''
    }`,
  )

  // For each report: snap to land, then build a small probe set for elevation.
  const allCarts: Cartographic[] = []
  const offsets: Array<{ start: number; count: number; snapped: [number, number] }> = []
  for (const r of reports) {
    const landOnly = requiresLand(r.type)
    const snapped = landOnly
      ? snapToLand(r.longitude, r.latitude, landSamples)
      : [r.longitude, r.latitude] as [number, number]
    const probes = elevationProbes(snapped[0], snapped[1], ELEVATION_PROBE_RADIUS_M[r.type])
    offsets.push({ start: allCarts.length, count: probes.length, snapped })
    for (const [lon, lat] of probes) {
      allCarts.push(Cartographic.fromDegrees(lon, lat))
    }
  }

  try {
    await viewer.scene.sampleHeightMostDetailed(allCarts)
  } catch (err) {
    console.warn('[DeploymentImporter] height sampling failed', err)
  }

  for (let i = 0; i < reports.length; i += 1) {
    const r = reports[i]
    const { start, count, snapped } = offsets[i]
    const landOnly = requiresLand(r.type)

    // Pick the highest-elevation probe — but ONLY among probes that aren't
    // themselves in water. Without this, a coastal asset's wide elevation probe
    // can drift back into the bay because Cesium sometimes reports water-surface
    // tiles as height ~0 m (which beats negative ellipsoidal heights of dry land
    // in regions with strong geoid undulation like SF).
    let bestIdx = -1
    let bestHeight = -Infinity
    for (let k = 0; k < count; k += 1) {
      const cart = allCarts[start + k]
      const h = Number.isFinite(cart.height) ? cart.height : -Infinity
      if (landOnly) {
        const lon = CesiumMath.toDegrees(cart.longitude)
        const lat = CesiumMath.toDegrees(cart.latitude)
        if (isInWater(lon, lat, waterPolygons)) continue
      }
      if (h > bestHeight) {
        bestHeight = h
        bestIdx = start + k
      }
    }
    if (bestIdx === -1) {
      // All probes filtered as water — fall back to the snapped point itself
      // (we know that's land because snapToLand picked from the eroded grid).
      bestIdx = start
    }
    const chosen = allCarts[bestIdx]
    const chosenLon = CesiumMath.toDegrees(chosen.longitude)
    const chosenLat = CesiumMath.toDegrees(chosen.latitude)
    const surfaceHeight = Number.isFinite(chosen.height) ? chosen.height : 0
    const stillWater = landOnly && isInWater(chosenLon, chosenLat, waterPolygons)
    const movedKm = haversineKm(r.longitude, r.latitude, chosenLon, chosenLat)
    console.log(
      `[DeploymentImporter] ${r.label ?? r.type}: snapped ${snapped[0].toFixed(5)},${snapped[1].toFixed(5)} → final ${chosenLon.toFixed(5)},${chosenLat.toFixed(5)} h=${surfaceHeight.toFixed(1)}m (moved ${movedKm.toFixed(2)}km, water=${stillWater})`,
    )
    if (stillWater) {
      console.warn(
        `[DeploymentImporter] ${r.label ?? r.type}: chosen position still in water after fallback — dropping`,
      )
      continue
    }

    store.addAsset({
      type: r.type,
      label: r.label ?? undefined,
      longitude: chosenLon,
      latitude: chosenLat,
      height: surfaceHeight + r.height_agl,
      frequencyMhz: r.frequency_mhz,
      erpDbm: r.erp_dbm,
      antennaPattern: 'omni',
      status: 'deployed',
    })
  }
  store.selectAsset(null)
  viewer.scene.requestRender()
}

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(a)))
}
