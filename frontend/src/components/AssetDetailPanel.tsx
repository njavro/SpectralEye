import { useStore } from '../store'
import { ASSET_TYPE_LABELS } from '../types'
import type { Asset } from '../types'
import { ASSET_TYPE_COLOR } from './assetVisuals'

export function AssetDetailPanel() {
  const selectedId = useStore((s) => s.selectedAssetId)
  const asset = useStore((s) => s.assets.find((a) => a.id === selectedId)) ?? null
  const updateAsset = useStore((s) => s.updateAsset)
  const removeAsset = useStore((s) => s.removeAsset)
  const selectAsset = useStore((s) => s.selectAsset)
  const coverageVisible = useStore((s) => (selectedId ? s.visibleCoverageIds.has(selectedId) : false))
  const toggleCoverageVisibility = useStore((s) => s.toggleCoverageVisibility)

  if (!asset) return null

  const set = <K extends keyof Asset>(key: K, value: Asset[K]) =>
    updateAsset(asset.id, { [key]: value } as Partial<Asset>)

  const isTransmitter = asset.type !== 'sensor'

  return (
    <aside className="detail-panel">
      <header className="detail-header">
        <span
          className="detail-type-swatch"
          style={{ background: ASSET_TYPE_COLOR[asset.type] }}
        />
        <span className="detail-type">{ASSET_TYPE_LABELS[asset.type]}</span>
        <button
          type="button"
          className="detail-close"
          onClick={() => selectAsset(null)}
          title="Close"
        >
          ×
        </button>
      </header>

      <div className="detail-section">
        <label className="detail-label">Callsign</label>
        <input
          type="text"
          className="detail-input"
          value={asset.label}
          onChange={(e) => set('label', e.target.value)}
        />
      </div>

      <div className="detail-section">
        <label className="detail-label">Status</label>
        <div className="detail-status-toggle">
          <button
            type="button"
            className={`status-pill${asset.status === 'deployed' ? ' active' : ''}`}
            onClick={() => set('status', 'deployed')}
          >
            Deployed
          </button>
          <button
            type="button"
            className={`status-pill${asset.status === 'hypothetical' ? ' active' : ''}`}
            onClick={() => set('status', 'hypothetical')}
          >
            Hypothetical
          </button>
        </div>
      </div>

      <div className="detail-row">
        <div className="detail-section">
          <label className="detail-label">Latitude</label>
          <div className="detail-input mono detail-readonly">{asset.latitude.toFixed(6)}°</div>
        </div>
        <div className="detail-section">
          <label className="detail-label">Longitude</label>
          <div className="detail-input mono detail-readonly">{asset.longitude.toFixed(6)}°</div>
        </div>
      </div>

      <div className="detail-section">
        <label className="detail-label">
          Height <span className="detail-unit">(m above ellipsoid)</span>
        </label>
        <div className="detail-input mono detail-readonly">{asset.height.toFixed(1)} m</div>
      </div>

      <div className="detail-row">
        <div className="detail-section">
          <label className="detail-label">
            Frequency <span className="detail-unit">(MHz)</span>
          </label>
          <input
            type="number"
            className="detail-input mono"
            step="1"
            value={asset.frequencyMhz}
            onChange={(e) => set('frequencyMhz', parseFloat(e.target.value))}
          />
        </div>
        {isTransmitter && (
          <div className="detail-section">
            <label className="detail-label">
              ERP <span className="detail-unit">(dBm)</span>
            </label>
            <input
              type="number"
              className="detail-input mono"
              step="1"
              value={asset.erpDbm}
              onChange={(e) => set('erpDbm', parseFloat(e.target.value))}
            />
          </div>
        )}
      </div>

      <div className="detail-section">
        <label className="detail-label">Antenna pattern</label>
        <div className="detail-input mono detail-readonly">
          Omnidirectional <span className="detail-unit">(only option in v0.1)</span>
        </div>
      </div>

      <div className="detail-actions">
        <button
          type="button"
          className="detail-ems-toggle"
          onClick={() => toggleCoverageVisibility(asset.id)}
        >
          {coverageVisible ? 'Hide EMS Footprint' : 'Show EMS Footprint'}
        </button>
        <button
          type="button"
          className="detail-delete"
          onClick={() => removeAsset(asset.id)}
        >
          Delete asset
        </button>
      </div>
    </aside>
  )
}
