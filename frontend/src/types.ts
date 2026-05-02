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
