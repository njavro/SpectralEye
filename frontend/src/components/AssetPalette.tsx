import { fetchCurrentDeployment } from '../api'
import { useStore } from '../store'
import { ASSET_TYPE_LABELS } from '../types'
import type { AssetType } from '../types'
import { ASSET_TYPE_COLOR } from './assetVisuals'

const TYPES: AssetType[] = ['jammer', 'sensor', 'relay']

export function AssetPalette() {
  const aoi = useStore((s) => s.aoi)
  const placeMode = useStore((s) => s.placeMode)
  const aoiInitializing = useStore((s) => s.aoiInitializing)
  const setPlaceMode = useStore((s) => s.setPlaceMode)
  const assetCount = useStore((s) => s.assets.length)
  const importing = useStore((s) => s.importingDeployment)
  const setPendingDeploymentReports = useStore((s) => s.setPendingDeploymentReports)
  const setImportingDeployment = useStore((s) => s.setImportingDeployment)

  const enabled = aoi !== null && !aoiInitializing

  const handleReportDeployment = async () => {
    if (!aoi) return
    setImportingDeployment(true)
    try {
      const report = await fetchCurrentDeployment(aoi.bbox)
      setPendingDeploymentReports(report.reports)
      // setImportingDeployment(false) is called by DeploymentImporter once heights
      // are sampled and assets added.
    } catch (err) {
      console.error('[AssetPalette] failed to fetch deployment', err)
      setImportingDeployment(false)
    }
  }

  return (
    <aside className="asset-palette">
      <div className="palette-header">
        <span className="palette-title">EW Assets</span>
        <span className="palette-count">{assetCount}</span>
      </div>
      {!enabled && (
        <div className="palette-empty">Mark an area of operation to begin placing assets.</div>
      )}
      {enabled && (
        <>
          <div className="palette-section-label">Self-report</div>
          <button
            type="button"
            className="palette-report-button"
            onClick={handleReportDeployment}
            disabled={importing}
          >
            {importing ? (
              <>
                <span className="report-spinner" /> Receiving reports…
              </>
            ) : (
              'Report Current Deployment'
            )}
          </button>
          <div className="palette-report-note">
            Pulls the C2's current view of self-reporting devices in the AOI.
          </div>

          <div className="palette-section-label palette-section-label-spaced">Place manually</div>
          <div className="palette-buttons">
            {TYPES.map((t) => {
              const active = placeMode === t
              return (
                <button
                  key={t}
                  type="button"
                  className={`palette-button${active ? ' active' : ''}`}
                  onClick={() => setPlaceMode(active ? null : t)}
                >
                  <span
                    className="palette-swatch"
                    style={{ background: ASSET_TYPE_COLOR[t] }}
                  />
                  <span className="palette-label">{ASSET_TYPE_LABELS[t]}</span>
                </button>
              )
            })}
          </div>
          {placeMode && (
            <div className="palette-hint">
              Click on the scene to drop the {ASSET_TYPE_LABELS[placeMode].toLowerCase()}.
              Press <kbd>Esc</kbd> to cancel.
            </div>
          )}
        </>
      )}
    </aside>
  )
}
