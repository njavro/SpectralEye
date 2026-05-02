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
