import type { Asset, AssetType, Bbox } from './types'

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

export type GridSpec = {
  bbox: Bbox
  voxel_size_m: number
  height_min_m: number
  height_max_m: number
}

export type CoverageGrid = {
  values: Float32Array
  nx: number
  ny: number
  nz: number
  bbox: Bbox
  height_min_m: number
  height_max_m: number
  voxel_size_m: number
  units: 'dBm'
  source: 'mock' | 'sionna_remote'
  computed_at: string
  asset_id?: string | null
}

export async function requestCoverage(
  asset: Asset,
  gridSpec: GridSpec,
  signal?: AbortSignal,
): Promise<CoverageGrid> {
  const r = await fetch(`${BASE}/coverage/sionna`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset: {
        type: asset.type,
        longitude: asset.longitude,
        latitude: asset.latitude,
        height: asset.height,
        frequency_mhz: asset.frequencyMhz,
        erp_dbm: asset.erpDbm,
        antenna_pattern: asset.antennaPattern,
      },
      grid_spec: {
        bbox: {
          west: gridSpec.bbox[0],
          south: gridSpec.bbox[1],
          east: gridSpec.bbox[2],
          north: gridSpec.bbox[3],
        },
        voxel_size_m: gridSpec.voxel_size_m,
        height_min_m: gridSpec.height_min_m,
        height_max_m: gridSpec.height_max_m,
      },
    }),
    signal,
  })
  if (!r.ok) throw new Error(`coverage fetch failed: ${r.status}`)
  const json = await r.json()
  // Decode base64 → Float32Array (path-loss values, row-major (i, j, k)).
  const bytes = base64ToUint8(json.values_b64)
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  return {
    values,
    nx: json.nx,
    ny: json.ny,
    nz: json.nz,
    bbox: [json.bbox.west, json.bbox.south, json.bbox.east, json.bbox.north],
    height_min_m: json.height_min_m,
    height_max_m: json.height_max_m,
    voxel_size_m: json.voxel_size_m,
    units: json.units,
    source: json.source,
    computed_at: json.computed_at,
    asset_id: json.asset_id,
  }
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

export type WaterPolygon = {
  outer: Array<[number, number]>
  holes: Array<Array<[number, number]>>
}

export type WaterPolygons = {
  polygons: WaterPolygon[]
}

export async function fetchWaterPolygons(
  bbox: Bbox,
  signal?: AbortSignal,
): Promise<WaterPolygons> {
  const r = await fetch(`${BASE}/water/in-bbox`, {
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
  if (!r.ok) throw new Error(`water fetch failed: ${r.status}`)
  return r.json()
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
