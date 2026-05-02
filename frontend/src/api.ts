import type { AssetType, Bbox } from './types'

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'

export type GeocodeResult = {
  display_name: string
  lat: number
  lon: number
  type?: string
  category?: string
  importance?: number
  bbox?: [number, number, number, number]
  address?: Record<string, string>
}

export async function reverseGeocode(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<GeocodeResult | null> {
  const url = new URL(`${BASE}/reverse`)
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`reverse geocode failed: ${r.status}`)
  return r.json()
}

export type AssetReport = {
  type: AssetType
  longitude: number
  latitude: number
  height_agl: number
  frequency_mhz: number
  erp_dbm: number
  label?: string | null
}

export type DeploymentReport = {
  reports: AssetReport[]
  source: 'simulated' | 'hardware'
}

export async function fetchCurrentDeployment(
  bbox: Bbox,
  signal?: AbortSignal,
): Promise<DeploymentReport> {
  const r = await fetch(`${BASE}/deployment/current`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      west: bbox[0],
      south: bbox[1],
      east: bbox[2],
      north: bbox[3],
    }),
    signal,
  })
  if (!r.ok) throw new Error(`deployment fetch failed: ${r.status}`)
  return r.json()
}
