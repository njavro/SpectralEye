import { useCallback, useEffect } from 'react'
import './cesium-config'
import { SceneViewer } from './components/SceneViewer'
import { AssetPalette } from './components/AssetPalette'
import { AssetDetailPanel } from './components/AssetDetailPanel'
import { reverseGeocode } from './api'
import { useStore } from './store'
import type { Bbox } from './types'
import './App.css'

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

  const dim = aoi ? bboxDimensionsKm(aoi.bbox) : null
  const center = aoi ? bboxCenter(aoi.bbox) : null

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
        </main>
        <AssetDetailPanel />
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
