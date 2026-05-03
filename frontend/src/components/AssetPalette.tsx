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
  const visibleCoverageCount = useStore((s) => s.visibleCoverageIds.size)
  const showAllCoverage = useStore((s) => s.showAllCoverage)
  const hideAllCoverage = useStore((s) => s.hideAllCoverage)
  const coverageTypesVisible = useStore((s) => s.coverageTypesVisible)
  const toggleCoverageType = useStore((s) => s.toggleCoverageType)

  const enabled = aoi !== null && !aoiInitializing
  const allVisible = assetCount > 0 && visibleCoverageCount === assetCount

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
          {placeMode && placeMode !== 'ooi' && placeMode !== 'drone-plan' && (
            <div className="palette-hint">
              Click on the scene to drop the {ASSET_TYPE_LABELS[placeMode].toLowerCase()}.
              Press <kbd>Esc</kbd> to cancel.
            </div>
          )}

          <div className="palette-section-label palette-section-label-spaced">
            Defended objects
          </div>
          <div className="palette-buttons">
            <button
              type="button"
              className={`palette-button${placeMode === 'ooi' ? ' active' : ''}`}
              onClick={() => setPlaceMode(placeMode === 'ooi' ? null : 'ooi')}
            >
              <span className="palette-swatch" style={{ background: '#22c55e' }} />
              <span className="palette-label">Place Strategic Point of Interest</span>
            </button>
          </div>
          {placeMode === 'ooi' && (
            <div className="palette-hint">
              Click on the scene to place a Strategic Point of Interest. Adjust its safety
              perimeter in the detail panel. Press <kbd>Esc</kbd> to exit.
            </div>
          )}

          {assetCount > 0 && (
            <>
              <div className="palette-section-label palette-section-label-spaced">
                Electromagnetic spectrum
              </div>
              <button
                type="button"
                className="palette-ems-button"
                onClick={() => (allVisible ? hideAllCoverage() : showAllCoverage())}
              >
                {allVisible ? 'Hide EMS' : 'Show EMS'}
                {visibleCoverageCount > 0 && !allVisible && (
                  <span className="palette-ems-count">
                    {visibleCoverageCount}/{assetCount}
                  </span>
                )}
              </button>
              <div className="palette-report-note">
                Toggle the predicted RF coverage volumes for all deployed assets.
              </div>
              <div className="palette-ems-types">
                {TYPES.map((t) => {
                  const on = coverageTypesVisible[t]
                  return (
                    <button
                      key={t}
                      type="button"
                      className={`palette-ems-type${on ? ' active' : ''}`}
                      onClick={() => toggleCoverageType(t)}
                      title={`${on ? 'Hide' : 'Show'} ${ASSET_TYPE_LABELS[t]} EMS overlay`}
                    >
                      <span
                        className="palette-swatch"
                        style={{ background: ASSET_TYPE_COLOR[t], opacity: on ? 1 : 0.3 }}
                      />
                      <span className="palette-label">{ASSET_TYPE_LABELS[t]}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  )
}
