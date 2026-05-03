// Bounding box: [west, south, east, north] in degrees.
export type Bbox = [number, number, number, number]

export type AreaOfOperation = {
  bbox: Bbox
  displayName: string | null
}

export type AssetType = 'jammer' | 'sensor' | 'relay'
export type AssetStatus = 'hypothetical' | 'deployed'
export type AntennaPattern = 'omni' // sectored/directional come in a later version

export type Asset = {
  id: string
  type: AssetType
  label: string
  // Geographic position. Height is meters above the WGS84 ellipsoid; this represents
  // the BASE of the asset (where it touches terrain or a building rooftop).
  longitude: number
  latitude: number
  height: number
  frequencyMhz: number
  // Effective radiated power in dBm (transmitters only; sensors leave this as 0).
  erpDbm: number
  antennaPattern: AntennaPattern
  status: AssetStatus
}

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  jammer: 'Jammer',
  sensor: 'RF Sensor',
  relay: 'Comms Relay',
}

export function defaultAssetParams(type: AssetType): Pick<
  Asset,
  'frequencyMhz' | 'erpDbm' | 'antennaPattern' | 'status'
> {
  switch (type) {
    case 'jammer':
      return { frequencyMhz: 2400, erpDbm: 50, antennaPattern: 'omni', status: 'deployed' }
    case 'sensor':
      return { frequencyMhz: 2400, erpDbm: 0, antennaPattern: 'omni', status: 'deployed' }
    case 'relay':
      return { frequencyMhz: 5800, erpDbm: 30, antennaPattern: 'omni', status: 'deployed' }
  }
}

// ---------------------------------------------------------------------------
// Threats and defended objects (Phase 6)
// ---------------------------------------------------------------------------

export type Waypoint = {
  longitude: number
  latitude: number
  height: number // m above WGS84 ellipsoid (absolute)
}

// A drone-class threat. Trajectory = start point + ordered waypoints. Speed
// determines how long the drone takes to traverse each segment when "Run"
// is pressed. Frequency + threshold are used by SJR jamming assessment.
export type Drone = {
  id: string
  label: string
  start: Waypoint
  waypoints: Waypoint[]
  speedMps: number
  frequencyMhz: number
  sjrThresholdDb: number
}

// A defended object whose immediate safety perimeter triggers an alert
// when a drone enters it.
export type ObjectOfInterest = {
  id: string
  label: string
  longitude: number
  latitude: number
  height: number
  perimeterRadiusM: number
}

export const DEFAULT_DRONE_SPEED_MPS = 15 // ~50 km/h, typical hobby quadcopter
export const DEFAULT_DRONE_FREQ_MHZ = 2400
export const DEFAULT_SJR_THRESHOLD_DB = 10
// How far above the picked surface a drone waypoint sits. 30 m is a reasonable
// drone-cruise altitude over a city for visual clarity (above most cars,
// streetlamps, but below typical building rooftops).
export const DEFAULT_DRONE_AGL_M = 30

export const DEFAULT_OOI_PERIMETER_M = 100
