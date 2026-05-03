import { create } from 'zustand'
import type { AssetReport, WaterPolygon } from './api'
import type { Asset, AssetType, AreaOfOperation } from './types'

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

type SpectralEyeState = {
  aoi: AreaOfOperation | null
  drawMode: boolean
  aoiInitializing: boolean
  assets: Asset[]
  selectedAssetId: string | null
  placeMode: AssetType | null
  // Reports from /deployment/current waiting to be ingested. The DeploymentImporter
  // component picks these up, samples surface heights via Cesium, and adds assets.
  pendingDeploymentReports: AssetReport[] | null
  // True from the moment we kick off a deployment fetch until import completes —
  // drives the button's loading spinner.
  importingDeployment: boolean
  // Asset IDs whose EMS (coverage) volume should be rendered. Empty by default —
  // operator opts in via "Show EMS" (all) or "Show EMS Footprint" (one).
  visibleCoverageIds: Set<string>
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
  setPlaceMode: (type: AssetType | null) => void
  clearAssets: () => void
  setPendingDeploymentReports: (r: AssetReport[] | null) => void
  setImportingDeployment: (on: boolean) => void

  toggleCoverageVisibility: (assetId: string) => void
  showAllCoverage: () => void
  hideAllCoverage: () => void
  setWaterPolygons: (p: WaterPolygon[] | null) => void
  setLandSamples: (s: Array<[number, number]> | null) => void
}

export const useStore = create<SpectralEyeState>((set, get) => ({
  aoi: null,
  drawMode: false,
  aoiInitializing: false,
  assets: [],
  selectedAssetId: null,
  placeMode: null,
  pendingDeploymentReports: null,
  importingDeployment: false,
  visibleCoverageIds: new Set(),
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
  selectAsset: (id) => set({ selectedAssetId: id }),
  setPlaceMode: (type) => set({ placeMode: type, selectedAssetId: null }),
  clearAssets: () => set({ assets: [], selectedAssetId: null, placeMode: null }),
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
  setWaterPolygons: (p) => set({ waterPolygons: p }),
  setLandSamples: (s) => set({ landSamples: s }),
}))
