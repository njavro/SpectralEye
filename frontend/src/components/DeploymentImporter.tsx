import { useEffect } from 'react'
import { useCesium } from 'resium'
import { Cartographic, Math as CesiumMath } from 'cesium'
import { useStore } from '../store'
import type { AssetReport } from '../api'
import type { AssetType } from '../types'

// Picks up self-reported deployment data from the store, samples actual surface
// heights at each report's lat/lon (so the asset lands on whatever surface is
// there — terrain or building rooftop), and adds the assets.
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

// Per-type search radius (meters) when biasing the candidate position toward
// the highest nearby surface. Jammers/sensors only need to find a nearby
// rooftop in dense urban (~25 m); relays specifically benefit from elevated
// vantage even on natural terrain so we widen their search to find ridges/hilltops.
const SEARCH_RADIUS_M: Record<AssetType, number> = {
  jammer: 25,
  sensor: 25,
  relay: 500,
}

function offsetLatLon(lat: number, lon: number, dxMeters: number, dyMeters: number) {
  const dLat = dyMeters / 111_320
  const dLon = dxMeters / (111_320 * Math.cos((lat * Math.PI) / 180))
  return { lat: lat + dLat, lon: lon + dLon }
}

// Build a candidate set centered on (lat, lon) with concentric rings of points.
// More rings + more candidates for relays so we actually sample enough of the
// surrounding terrain to locate a high spot.
function candidatesFor(type: AssetType, lat: number, lon: number): Cartographic[] {
  const radius = SEARCH_RADIUS_M[type]
  const out: Cartographic[] = [Cartographic.fromDegrees(lon, lat)]

  if (type === 'relay') {
    // Two rings (half radius + full radius), 12 points each = 25 candidates total.
    for (const r of [radius * 0.5, radius]) {
      for (let i = 0; i < 12; i += 1) {
        const a = (i / 12) * 2 * Math.PI
        const p = offsetLatLon(lat, lon, r * Math.cos(a), r * Math.sin(a))
        out.push(Cartographic.fromDegrees(p.lon, p.lat))
      }
    }
  } else {
    // Single hex ring (6 points) at the search radius.
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * 2 * Math.PI
      const p = offsetLatLon(lat, lon, radius * Math.cos(a), radius * Math.sin(a))
      out.push(Cartographic.fromDegrees(p.lon, p.lat))
    }
  }
  return out
}

async function importReports(
  viewer: NonNullable<ReturnType<typeof useCesium>['viewer']>,
  reports: AssetReport[],
) {
  // Build flat candidate batch but remember each report's slice.
  const candidates: Cartographic[] = []
  const offsets: { start: number; count: number }[] = []
  for (const r of reports) {
    const c = candidatesFor(r.type, r.latitude, r.longitude)
    offsets.push({ start: candidates.length, count: c.length })
    candidates.push(...c)
  }

  try {
    await viewer.scene.sampleHeightMostDetailed(candidates)
  } catch (err) {
    console.warn('[DeploymentImporter] height sampling failed', err)
  }

  const store = useStore.getState()
  for (let i = 0; i < reports.length; i += 1) {
    const r = reports[i]
    const { start, count } = offsets[i]

    let bestIdx = start
    let bestHeight = -Infinity
    for (let k = 0; k < count; k += 1) {
      const cart = candidates[start + k]
      const h = Number.isFinite(cart.height) ? cart.height : -Infinity
      if (h > bestHeight) {
        bestHeight = h
        bestIdx = start + k
      }
    }
    const chosen = candidates[bestIdx]
    const surfaceHeight = Number.isFinite(chosen.height) ? chosen.height : 0

    store.addAsset({
      type: r.type,
      label: r.label ?? undefined,
      longitude: CesiumMath.toDegrees(chosen.longitude),
      latitude: CesiumMath.toDegrees(chosen.latitude),
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
