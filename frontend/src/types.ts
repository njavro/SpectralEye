// Bounding box: [west, south, east, north] in degrees.
export type Bbox = [number, number, number, number]

export type AreaOfOperation = {
  bbox: Bbox
  // Friendly label, populated lazily via reverse geocoding the bbox center.
  // May be null while loading or if reverse geocoding fails.
  displayName: string | null
}
