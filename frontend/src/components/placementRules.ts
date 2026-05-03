import type { WaterPolygon } from '../api'
import type { AssetType } from '../types'

export function requiresLand(type: AssetType): boolean {
  switch (type) {
    case 'jammer':
    case 'sensor':
    case 'relay':
      return true
  }
}

// Ray-casting point-in-ring test for [lon, lat] coordinates against a closed
// polygon ring. Standard algorithm; works fine on the lat/lon plane at AOI scales.
function pointInRing(lon: number, lat: number, ring: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// Test against a polygon WITH HOLES — point is in water if it's inside the
// outer ring AND not inside any hole. This is critical for things like SF Bay
// where the bay polygon wraps around the SF peninsula (peninsula is a hole).
function pointInPolygon(lon: number, lat: number, polygon: WaterPolygon): boolean {
  if (!pointInRing(lon, lat, polygon.outer)) return false
  for (const hole of polygon.holes) {
    if (pointInRing(lon, lat, hole)) return false
  }
  return true
}

export function isInWater(
  lon: number,
  lat: number,
  waterPolygons: WaterPolygon[],
): boolean {
  for (const poly of waterPolygons) {
    if (pointInPolygon(lon, lat, poly)) return true
  }
  return false
}
