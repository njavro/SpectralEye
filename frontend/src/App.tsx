import { useCallback, useEffect } from 'react'
import './cesium-config'
import { SceneViewer } from './components/SceneViewer'
import { AssetPalette } from './components/AssetPalette'
import { AssetDetailPanel } from './components/AssetDetailPanel'
import { DroneDetailPanel } from './components/DroneDetailPanel'
import { IntrusionAlertOverlay } from './components/IntrusionAlertOverlay'
import { OoIDetailPanel } from './components/OoIDetailPanel'
import { SituationModelingPanel } from './components/SituationModelingPanel'
import { fetchWaterPolygons, reverseGeocode } from './api'
import { useStore } from './store'
import { isInWater } from './components/placementRules'
import type { Bbox } from './types'
import './App.css'

// Resolution of the AOI land-sample grid. 150×150 = 22,500 candidates; at a 5 km
// AOI that's ~33 m per cell — fine enough to snap precisely.
const LAND_GRID_RESOLUTION = 150
// How many neighbor-cells thick a land cell's water-free buffer must be.
// Combined with grid resolution this gives ~66 m of clearance from any water
// edge — tolerates OSM-polygon-vs-satellite-imagery misalignment.
const LAND_EROSION_CELLS = 2

function computeLandSamples(
  bbox: Bbox,
  waterPolygons: Parameters<typeof isInWater>[2],
  resolution = LAND_GRID_RESOLUTION,
): Array<[number, number]> {
  const [west, south, east, north] = bbox
  const lonStep = (east - west) / resolution
  const latStep = (north - south) / resolution

  // Pass 1: classify every grid cell as land or water.
  const isLand = new Uint8Array(resolution * resolution)
  for (let i = 0; i < resolution; i += 1) {
    const lon = west + (i + 0.5) * lonStep
    for (let j = 0; j < resolution; j += 1) {
      const lat = south + (j + 0.5) * latStep
      isLand[i * resolution + j] = isInWater(lon, lat, waterPolygons) ? 0 : 1
    }
  }

  // Pass 2: erode — only keep cells whose neighbors within `LAND_EROSION_CELLS`
  // are also land. Drops boundary cells so we never snap to a position right
  // next to (or slightly past) a coastline.
  const e = LAND_EROSION_CELLS
  const out: Array<[number, number]> = []
  for (let i = e; i < resolution - e; i += 1) {
    for (let j = e; j < resolution - e; j += 1) {
      let allLand = true
      for (let di = -e; di <= e && allLand; di += 1) {
        for (let dj = -e; dj <= e; dj += 1) {
          if (!isLand[(i + di) * resolution + (j + dj)]) {
            allLand = false
            break
          }
        }
      }
      if (allLand) {
        const lon = west + (i + 0.5) * lonStep
        const lat = south + (j + 0.5) * latStep
        out.push([lon, lat])
      }
    }
  }
  return out
}

function bboxCenter(bbox: Bbox): { lat: number; lon: number } {
  return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 }
}

function bboxDimensionsKm(bbox: Bbox): { width: number; height: number } {
  const [west, south, east, north] = bbox
  const meanLat = (south + north) / 2
  const widthKm = (east - west) * Math.cos((meanLat * Math.PI) / 180) * 111.32
  const heightKm = (north - south) * 111.32
  return { width: Math.abs(widthKm), height: Math.abs(heightKm) }
}

function fmtCoord(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`
}

function App() {
  const aoi = useStore((s) => s.aoi)
  const drawMode = useStore((s) => s.drawMode)
  const aoiInitializing = useStore((s) => s.aoiInitializing)
  const setAoi = useStore((s) => s.setAoi)
  const patchAoi = useStore((s) => s.patchAoi)
  const setDrawMode = useStore((s) => s.setDrawMode)
  const setAoiInitializing = useStore((s) => s.setAoiInitializing)
  const clearAssets = useStore((s) => s.clearAssets)
  const setWaterPolygons = useStore((s) => s.setWaterPolygons)
  const setLandSamples = useStore((s) => s.setLandSamples)
  const waterPolygons = useStore((s) => s.waterPolygons)

  const handleBboxDrawn = useCallback(
    (bbox: Bbox) => {
      console.log('[App] bbox drawn → committing AOI', bbox)
      setAoi({ bbox, displayName: null })
      setDrawMode(false)
      setAoiInitializing(true)
    },
    [setAoi, setDrawMode, setAoiInitializing],
  )

  const handleCancelDraw = useCallback(() => setDrawMode(false), [setDrawMode])

  const handleAoiBuildingsReady = useCallback(
    () => setAoiInitializing(false),
    [setAoiInitializing],
  )

  const startDrawing = () => {
    setAoi(null)
    clearAssets()
    setAoiInitializing(false)
    setDrawMode(true)
  }

  const resetAoi = () => {
    setAoi(null)
    clearAssets()
    setDrawMode(false)
    setAoiInitializing(false)
  }

  // Reverse-geocode AOI center.
  useEffect(() => {
    if (!aoi || aoi.displayName !== null) return
    const controller = new AbortController()
    const { lat, lon } = bboxCenter(aoi.bbox)
    reverseGeocode(lat, lon, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return
        patchAoi({ displayName: r?.display_name ?? '' })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [aoi, patchAoi])

  // Fetch OSM water polygons for the AOI so land-only assets can be rejected
  // from water positions. Cleared on AOI reset.
  useEffect(() => {
    if (!aoi) {
      setWaterPolygons(null)
      setLandSamples(null)
      return
    }
    const controller = new AbortController()
    fetchWaterPolygons(aoi.bbox, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return
        console.log(`[App] water polygons loaded: ${res.polygons.length}`)
        setWaterPolygons(res.polygons)
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.warn('[App] water fetch failed — proceeding without water rejection', err)
          setWaterPolygons([])
        }
      })
    return () => controller.abort()
  }, [aoi, setWaterPolygons, setLandSamples])

  // Pre-compute the AOI's land sample grid. Heavy-ish (~10 ms for 80×80) but
  // runs once per AOI, so subsequent placements snap to land in O(N) per asset.
  useEffect(() => {
    if (!aoi || !waterPolygons) {
      setLandSamples(null)
      return
    }
    const t0 = performance.now()
    const samples = computeLandSamples(aoi.bbox, waterPolygons)
    const dt = performance.now() - t0
    console.log(
      `[App] land samples computed: ${samples.length} of ${LAND_GRID_RESOLUTION ** 2} cells are land (${dt.toFixed(0)} ms)`,
    )
    setLandSamples(samples)
  }, [aoi, waterPolygons, setLandSamples])

  const dim = aoi ? bboxDimensionsKm(aoi.bbox) : null
  const center = aoi ? bboxCenter(aoi.bbox) : null
  const situationModelingOpen = useStore((s) => s.situationModelingOpen)
  const toggleSituationModeling = useStore((s) => s.toggleSituationModeling)

  return (
    <div className={`app-shell${drawMode ? ' draw-mode' : ''}`}>
      <header className="top-bar">
        <div className="top-bar-left">
          <span className="brand">SpectralEye</span>
          <span className="subtitle">EW C2 — v0.1</span>
        </div>
        <div className="top-bar-center">
          {aoi ? (
            <>
              <span className="location-label">Area:</span>
              <span className="location-name" title={aoi.displayName ?? ''}>
                {aoi.displayName || (center && fmtCoord(center.lat, center.lon))}
              </span>
              {dim && (
                <span className="location-dim">
                  {dim.width.toFixed(1)} × {dim.height.toFixed(1)} km
                </span>
              )}
            </>
          ) : drawMode ? (
            <span className="entry-instruction-bar">
              Click and drag on the map to define the AOI rectangle —{' '}
              <kbd>Esc</kbd> to cancel
            </span>
          ) : (
            <span className="entry-instruction-bar">
              Use the toolbar to mark your area of operation
            </span>
          )}
        </div>
        <div className="top-bar-right">
          {aoi && (
            <button
              type="button"
              className={`change-location${situationModelingOpen ? ' active' : ''}`}
              onClick={toggleSituationModeling}
            >
              Situation Modeling
            </button>
          )}
          {aoi ? (
            <button type="button" className="change-location" onClick={resetAoi}>
              Reset area
            </button>
          ) : drawMode ? (
            <button type="button" className="change-location" onClick={handleCancelDraw}>
              Cancel
            </button>
          ) : (
            <button type="button" className="primary-button" onClick={startDrawing}>
              Mark AOI
            </button>
          )}
        </div>
      </header>

      <div className="workspace">
        <AssetPalette />
        <main className="scene-container">
          <SceneViewer
            aoi={aoi}
            drawMode={drawMode}
            onBboxDrawn={handleBboxDrawn}
            onCancelDraw={handleCancelDraw}
            onAoiBuildingsReady={handleAoiBuildingsReady}
          />
          {aoiInitializing && <InitializingOverlay />}
          <EmsLoadingOverlay />
          <DeploymentLoadingOverlay />
        </main>
        <AssetDetailPanel />
        <DroneDetailPanel />
        <OoIDetailPanel />
        <SituationModelingPanel />
      </div>
      <IntrusionAlertOverlay />
    </div>
  )
}

function EmsLoadingOverlay() {
  const pending = useStore((s) => s.pendingCoverageFetches)
  if (pending <= 0) return null
  return (
    <div className="initializing-overlay">
      <div className="initializing-card">
        <div className="initializing-spinner" />
        <div className="initializing-text">
          <div className="initializing-title">Generating Electromagnetic Environment</div>
          <div className="initializing-subtitle">
            Ray-tracing RF propagation for {pending} asset
            {pending === 1 ? '' : 's'}…
          </div>
        </div>
      </div>
    </div>
  )
}

function DeploymentLoadingOverlay() {
  const message = useStore((s) => s.deploymentLoadingMessage)
  if (!message) return null
  return (
    <div className="initializing-overlay">
      <div className="initializing-card">
        <div className="initializing-spinner" />
        <div className="initializing-text">
          <div className="initializing-title">Reporting Current Deployment</div>
          <div className="initializing-subtitle">{message}</div>
        </div>
      </div>
    </div>
  )
}

function InitializingOverlay() {
  return (
    <div className="initializing-overlay">
      <div className="initializing-card">
        <div className="initializing-spinner" />
        <div className="initializing-text">
          <div className="initializing-title">Initializing the C2 EW Platform</div>
          <div className="initializing-subtitle">
            Loading building geometry and terrain for the area of operation…
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
