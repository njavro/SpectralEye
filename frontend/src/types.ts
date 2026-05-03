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
      // 40 dBm = 10 W. Typical man-portable counter-UAS jammer. The previous
      // default of 50 dBm (100 W) was a vehicle-mounted area-denial system
      // and made the contested airspace dominate any realistic AOI.
      return { frequencyMhz: 2400, erpDbm: 40, antennaPattern: 'omni', status: 'deployed' }
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
// Cruise altitude — meters above ground level. Every waypoint is normalised
// to terrain_height(lon, lat) + DEFAULT_DRONE_AGL_M, so a path stays at a
// fixed AGL regardless of whether the operator clicked on flat ground, a
// hill, a building rooftop, or a defended-asset dome. Buildings and other
// rendered geometry are deliberately ignored — see ThreatInteraction for why.
export const DEFAULT_DRONE_AGL_M = 50

export const DEFAULT_OOI_PERIMETER_M = 100

// Assumed received-signal level at the drone from its operator's control link,
// in dBm. SJR = DRONE_LINK_REFERENCE_DBM - jammer_dbm_at_drone. With a default
// SJR threshold of 10 dB, the drone is jammed when a co-channel jammer
// produces > -65 dBm at the drone's position.
export const DRONE_LINK_REFERENCE_DBM = -55
// A jammer is co-channel with the drone if its center frequency is within
// this band (MHz). Wider than typical control-link bandwidth (~20 MHz) so
// that minor mismatches in operator-tuned jammer setups still register.
export const FREQUENCY_MATCH_TOLERANCE_MHZ = 80

// Effective-coverage tolerances per non-jammer asset type — how many dB of
// margin the asset needs over the strongest co-channel jammer at a given
// voxel for that voxel to still count as "covered." Used by CoverageLayer
// to render a vivid "effective" volume inside each asset's faded nominal
// shell, so the operator sees friendly footprint shrink in real time when
// a jammer is added.
//
//   relay  : digital comms link → ~10 dB SJR margin matches the drone-link
//            assumption used elsewhere in the sim.
//   sensor : detection rather than communication → ~6 dB above the raised
//            noise floor a co-channel jammer creates.
export const RELAY_SJR_MARGIN_DB = 10
export const SENSOR_SNR_MARGIN_DB = 6

// Contested-airspace boundary — DERIVED from the simulation's jamming
// constants so the rendered volume can never drift out of sync with what
// drones actually experience. The visual is a SINGLE solid shell at this
// threshold (matching the simulation's default jamming boundary), so the
// operator can read the map literally: inside the volume → drone gets
// jammed, outside → drone flies clear. No nested shells; no interpretation.
export const JAMMER_CONTESTED_THRESHOLD_DBM =
  DRONE_LINK_REFERENCE_DBM - DEFAULT_SJR_THRESHOLD_DB

export type DroneStatus = 'flying' | 'finished' | 'jammed' | 'intrusion'

// Per-drone live state during simulation. Maintained alongside drones[]; one
// entry per drone, kept in sync by the store's add/remove/clear actions.
export type DroneRuntime = {
  id: string
  position: Waypoint
  status: DroneStatus
  // Asset id of the jammer that took down the link. Set the first time SJR
  // crosses the threshold, then locked in (drone freezes in place).
  jammedBy: string | null
  // Strongest co-channel jammer signal at the drone position, in dBm.
  jammerSignalDbm: number | null
  sjrDb: number | null
  // OoI id whose perimeter the drone breached. Independent of `jammedBy` —
  // a drone can intrude, get jammed, or both.
  intrudedOoi: string | null
}

export type SimulationStatus = 'idle' | 'running' | 'paused' | 'finished'

// A latched perimeter-breach record. Intrusion events accumulate here as the
// simulation detects them and persist until the operator acknowledges via the
// "Situation mitigated" button on the alert overlay — even after the drone
// exits the dome or the run ends. Labels are captured at detection time so
// the record stays interpretable even if the drone is later removed.
export type IntrusionEvent = {
  droneId: string
  droneLabel: string
  ooiId: string
  ooiLabel: string
  // Simulation time (seconds) at the moment of breach.
  detectedAt: number
  frequencyMhz: number
}
