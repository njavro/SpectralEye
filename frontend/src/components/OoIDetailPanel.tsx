import { useStore } from '../store'
import type { ObjectOfInterest } from '../types'
import { OOI_COLOR } from './threatVisuals'

export function OoIDetailPanel() {
  const selectedId = useStore((s) => s.selectedOoiId)
  const ooi = useStore((s) => s.ois.find((o) => o.id === selectedId)) ?? null
  const updateOoi = useStore((s) => s.updateOoi)
  const removeOoi = useStore((s) => s.removeOoi)
  const selectOoi = useStore((s) => s.selectOoi)

  if (!ooi) return null

  const set = <K extends keyof ObjectOfInterest>(key: K, value: ObjectOfInterest[K]) =>
    updateOoi(ooi.id, { [key]: value } as Partial<ObjectOfInterest>)

  return (
    <aside className="detail-panel">
      <header className="detail-header">
        <span className="detail-type-swatch" style={{ background: OOI_COLOR.marker }} />
        <span className="detail-type">Strategic Point of Interest</span>
        <button
          type="button"
          className="detail-close"
          onClick={() => selectOoi(null)}
          title="Close"
        >
          ×
        </button>
      </header>

      <div className="detail-section">
        <label className="detail-label">Label</label>
        <input
          type="text"
          className="detail-input"
          value={ooi.label}
          onChange={(e) => set('label', e.target.value)}
        />
      </div>

      <div className="detail-row">
        <div className="detail-section">
          <label className="detail-label">Latitude</label>
          <div className="detail-input mono detail-readonly">{ooi.latitude.toFixed(6)}°</div>
        </div>
        <div className="detail-section">
          <label className="detail-label">Longitude</label>
          <div className="detail-input mono detail-readonly">{ooi.longitude.toFixed(6)}°</div>
        </div>
      </div>

      <div className="detail-section">
        <label className="detail-label">
          Safety perimeter <span className="detail-unit">(m radius)</span>
        </label>
        <input
          type="number"
          className="detail-input mono"
          step="10"
          min="10"
          value={ooi.perimeterRadiusM}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v) && v > 0) set('perimeterRadiusM', v)
          }}
        />
      </div>

      <div className="detail-section">
        <label className="detail-label">
          Ground elevation <span className="detail-unit">(m above ellipsoid)</span>
        </label>
        <div className="detail-input mono detail-readonly">{ooi.height.toFixed(1)} m</div>
      </div>

      <div className="detail-actions">
        <button
          type="button"
          className="detail-delete"
          onClick={() => removeOoi(ooi.id)}
        >
          Delete SPoI
        </button>
      </div>
    </aside>
  )
}
