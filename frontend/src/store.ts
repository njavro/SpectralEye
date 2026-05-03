import { create } from 'zustand'
import type { AssetReport, WaterPolygon } from './api'
import {
  DEFAULT_DRONE_FREQ_MHZ,
  DEFAULT_DRONE_SPEED_MPS,
  DEFAULT_SJR_THRESHOLD_DB,
} from './types'
import type {
  AreaOfOperation,
  Asset,
  AssetType,
  Drone,
  ObjectOfInterest,
  Waypoint,
} from './types'

let assetCounter = 0
function nextLabel(type: AssetType, existing: Asset[]): string {
  const prefix = type === 'jammer' ? 'JAM' : type === 'sensor' ? 'SEN' : 'RLY'
  const used = new Set(
    existing
      .filter((a) => a.type === type)
      .map((a) => parseInt(a.label.replace(prefix + '-', ''), 10))
      .filter((n) => !Number.isNaN(n)),
  )
  let n = 1
  while (used.has(n)) n += 1
  return `${prefix}-${String(n).padStart(2, '0')}`
}

let droneCounter = 0
function nextDroneLabel(existing: Drone[]): string {
  const used = new Set(
    existing
      .map((d) => parseInt(d.label.replace('DRN-', ''), 10))
      .filter((n) => !Number.isNaN(n)),
  )
  let n = 1
  while (used.has(n)) n += 1
  return `DRN-${String(n).padStart(2, '0')}`
}

let ooiCounter = 0
function nextOoiLabel(existing: ObjectOfInterest[]): string {
  const used = new Set(
    existing
      .map((o) => parseInt(o.label.replace('OOI-', ''), 10))
      .filter((n) => !Number.isNaN(n)),
  )
  let n = 1
  while (used.has(n)) n += 1
  return `OOI-${String(n).padStart(2, '0')}`
}

// Place modes extend across asset types + threats + defended objects.
// 'drone-plan' has special behavior — first click creates the drone, subsequent
// clicks accumulate waypoints onto the drone identified by `dronePlanningId`.
export type PlaceMode = AssetType | 'ooi' | 'drone-plan'

type SpectralEyeState = {
  aoi: AreaOfOperation | null
  drawMode: boolean
  aoiInitializing: boolean
  assets: Asset[]
  drones: Drone[]
  ois: ObjectOfInterest[]
  selectedAssetId: string | null
  selectedDroneId: string | null
  selectedOoiId: string | null
  placeMode: PlaceMode | null
  // ID of the drone currently accumulating waypoints in 'drone-plan' mode.
  // null when not in drone-plan mode or before the first click is registered.
  dronePlanningId: string | null
  // Reports from /deployment/current waiting to be ingested. The DeploymentImporter
  // component picks these up, samples surface heights via Cesium, and adds assets.
  pendingDeploymentReports: AssetReport[] | null
  // True from the moment we kick off a deployment fetch until import completes —
  // drives the button's loading spinner.
  importingDeployment: boolean
  // Asset IDs whose EMS (coverage) volume should be rendered. Empty by default —
  // operator opts in via "Show EMS" (all) or "Show EMS Footprint" (one).
  visibleCoverageIds: Set<string>
  // Per-type EMS visibility filter. A coverage volume is rendered only when
  // its asset's id is in visibleCoverageIds AND its type is enabled here.
  coverageTypesVisible: Record<AssetType, boolean>
  // Number of coverage requests currently in flight to the Sionna service.
  // Drives the "Generating Electromagnetic Environment" overlay.
  pendingCoverageFetches: number
  // Situation Modeling panel (right side) — drone planning + mission rehearsal
  // controls live here, separated from the EW asset / SPoI palette on the left.
  situationModelingOpen: boolean
  // OSM water polygons within the current AOI, used to reject land-only assets
  // dropped on water. null while loading or before AOI is set.
  waterPolygons: WaterPolygon[] | null
  // Pre-computed land sample positions across the AOI (water filtered out).
  // Used by DeploymentImporter to snap reports to nearby land instead of
  // random-rejecting positions in water.
  landSamples: Array<[number, number]> | null

  setAoi: (aoi: AreaOfOperation | null) => void
  patchAoi: (patch: Partial<AreaOfOperation>) => void
  setDrawMode: (on: boolean) => void
  setAoiInitializing: (on: boolean) => void

  addAsset: (
    init: Omit<Asset, 'id' | 'label'> & { label?: string },
  ) => Asset
  updateAsset: (id: string, patch: Partial<Asset>) => void
  removeAsset: (id: string) => void
  selectAsset: (id: string | null) => void

  addDrone: (start: Waypoint, label?: string) => Drone
  updateDrone: (id: string, patch: Partial<Drone>) => void
  removeDrone: (id: string) => void
  appendDroneWaypoint: (id: string, wp: Waypoint) => void
  selectDrone: (id: string | null) => void

  addOoi: (init: Omit<ObjectOfInterest, 'id' | 'label'> & { label?: string }) => ObjectOfInterest
  updateOoi: (id: string, patch: Partial<ObjectOfInterest>) => void
  removeOoi: (id: string) => void
  selectOoi: (id: string | null) => void

  setPlaceMode: (mode: PlaceMode | null) => void
  finishDronePlanning: () => void
  clearAssets: () => void
  setPendingDeploymentReports: (r: AssetReport[] | null) => void
  setImportingDeployment: (on: boolean) => void

  toggleCoverageVisibility: (assetId: string) => void
  showAllCoverage: () => void
  hideAllCoverage: () => void
  toggleCoverageType: (type: AssetType) => void
  beginCoverageFetch: () => void
  endCoverageFetch: () => void
  setSituationModelingOpen: (open: boolean) => void
  toggleSituationModeling: () => void
  setWaterPolygons: (p: WaterPolygon[] | null) => void
  setLandSamples: (s: Array<[number, number]> | null) => void
}

export const useStore = create<SpectralEyeState>((set, get) => ({
  aoi: null,
  drawMode: false,
  aoiInitializing: false,
  assets: [],
  drones: [],
  ois: [],
  selectedAssetId: null,
  selectedDroneId: null,
  selectedOoiId: null,
  placeMode: null,
  dronePlanningId: null,
  pendingDeploymentReports: null,
  importingDeployment: false,
  visibleCoverageIds: new Set(),
  coverageTypesVisible: { jammer: true, sensor: true, relay: true },
  pendingCoverageFetches: 0,
  situationModelingOpen: false,
  waterPolygons: null,
  landSamples: null,

  setAoi: (aoi) => set({ aoi }),
  patchAoi: (patch) =>
    set((s) => (s.aoi ? { aoi: { ...s.aoi, ...patch } } : {})),
  setDrawMode: (on) => set({ drawMode: on }),
  setAoiInitializing: (on) => set({ aoiInitializing: on }),

  addAsset: (init) => {
    const id = `asset-${Date.now()}-${assetCounter++}`
    const label = init.label ?? nextLabel(init.type, get().assets)
    const asset: Asset = { ...init, id, label }
    set((s) => ({
      assets: [...s.assets, asset],
      selectedAssetId: id,
      placeMode: null, // exit place mode after dropping one
    }))
    return asset
  },
  updateAsset: (id, patch) =>
    set((s) => ({
      assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),
  removeAsset: (id) =>
    set((s) => ({
      assets: s.assets.filter((a) => a.id !== id),
      selectedAssetId: s.selectedAssetId === id ? null : s.selectedAssetId,
    })),
  selectAsset: (id) =>
    set({ selectedAssetId: id, selectedDroneId: null, selectedOoiId: null }),

  addDrone: (start, label) => {
    const id = `drone-${Date.now()}-${droneCounter++}`
    let asset: Drone | null = null
    set((s) => {
      asset = {
        id,
        label: label ?? nextDroneLabel(s.drones),
        start,
        waypoints: [],
        speedMps: DEFAULT_DRONE_SPEED_MPS,
        frequencyMhz: DEFAULT_DRONE_FREQ_MHZ,
        sjrThresholdDb: DEFAULT_SJR_THRESHOLD_DB,
      }
      return { drones: [...s.drones, asset], selectedDroneId: id, dronePlanningId: id }
    })
    return asset!
  },
  updateDrone: (id, patch) =>
    set((s) => ({
      drones: s.drones.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    })),
  removeDrone: (id) =>
    set((s) => ({
      drones: s.drones.filter((d) => d.id !== id),
      selectedDroneId: s.selectedDroneId === id ? null : s.selectedDroneId,
      dronePlanningId: s.dronePlanningId === id ? null : s.dronePlanningId,
    })),
  appendDroneWaypoint: (id, wp) =>
    set((s) => ({
      drones: s.drones.map((d) => (d.id === id ? { ...d, waypoints: [...d.waypoints, wp] } : d)),
    })),
  selectDrone: (id) =>
    set({ selectedDroneId: id, selectedAssetId: null, selectedOoiId: null }),

  addOoi: (init) => {
    const id = `ooi-${Date.now()}-${ooiCounter++}`
    let ooi: ObjectOfInterest | null = null
    set((s) => {
      ooi = {
        ...init,
        id,
        label: init.label ?? nextOoiLabel(s.ois),
      }
      return { ois: [...s.ois, ooi], selectedOoiId: id, placeMode: null }
    })
    return ooi!
  },
  updateOoi: (id, patch) =>
    set((s) => ({
      ois: s.ois.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    })),
  removeOoi: (id) =>
    set((s) => ({
      ois: s.ois.filter((o) => o.id !== id),
      selectedOoiId: s.selectedOoiId === id ? null : s.selectedOoiId,
    })),
  selectOoi: (id) =>
    set({ selectedOoiId: id, selectedAssetId: null, selectedDroneId: null }),

  setPlaceMode: (mode) =>
    set({
      placeMode: mode,
      selectedAssetId: null,
      selectedDroneId: null,
      selectedOoiId: null,
      // Drone-plan mode resets the planning pointer; the first click creates the
      // drone and writes the id back into dronePlanningId.
      dronePlanningId: mode === 'drone-plan' ? null : null,
    }),
  finishDronePlanning: () => set({ placeMode: null, dronePlanningId: null }),
  clearAssets: () =>
    set({
      assets: [],
      drones: [],
      ois: [],
      selectedAssetId: null,
      selectedDroneId: null,
      selectedOoiId: null,
      placeMode: null,
      dronePlanningId: null,
    }),
  setPendingDeploymentReports: (r) => set({ pendingDeploymentReports: r }),
  setImportingDeployment: (on) => set({ importingDeployment: on }),

  toggleCoverageVisibility: (assetId) =>
    set((s) => {
      const next = new Set(s.visibleCoverageIds)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return { visibleCoverageIds: next }
    }),
  showAllCoverage: () =>
    set((s) => ({ visibleCoverageIds: new Set(s.assets.map((a) => a.id)) })),
  hideAllCoverage: () => set({ visibleCoverageIds: new Set() }),
  toggleCoverageType: (type) =>
    set((s) => ({
      coverageTypesVisible: {
        ...s.coverageTypesVisible,
        [type]: !s.coverageTypesVisible[type],
      },
    })),
  beginCoverageFetch: () =>
    set((s) => ({ pendingCoverageFetches: s.pendingCoverageFetches + 1 })),
  endCoverageFetch: () =>
    set((s) => ({ pendingCoverageFetches: Math.max(0, s.pendingCoverageFetches - 1) })),
  setSituationModelingOpen: (open) => set({ situationModelingOpen: open }),
  toggleSituationModeling: () =>
    set((s) => ({ situationModelingOpen: !s.situationModelingOpen })),
  setWaterPolygons: (p) => set({ waterPolygons: p }),
  setLandSamples: (s) => set({ landSamples: s }),
}))
