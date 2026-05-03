import { useStore } from '../store'
import type { Drone } from '../types'
import { pathTotalLengthMeters } from './simulation'
import { DRONE_COLOR } from './threatVisuals'

export function DroneDetailPanel() {
  const selectedId = useStore((s) => s.selectedDroneId)
  const drone = useStore((s) => s.drones.find((d) => d.id === selectedId)) ?? null
  const runtime = useStore((s) => (selectedId ? s.droneRuntime[selectedId] : undefined))
  const updateDrone = useStore((s) => s.updateDrone)
  const removeDrone = useStore((s) => s.removeDrone)
  const selectDrone = useStore((s) => s.selectDrone)

  if (!drone) return null

  const set = <K extends keyof Drone>(key: K, value: Drone[K]) =>
    updateDrone(drone.id, { [key]: value } as Partial<Drone>)

  const totalPathM = pathTotalLengthMeters(drone)
  const etaSeconds = drone.speedMps > 0 ? totalPathM / drone.speedMps : 0
  const statusBadge = runtimeBadge(runtime?.status)

  return (
    <aside className="detail-panel">
      <header className="detail-header">
        <span className="detail-type-swatch" style={{ background: DRONE_COLOR.clear }} />
        <span className="detail-type">Hostile Drone</span>
        {statusBadge && (
          <span className={`detail-status-pill ${statusBadge.className}`}>{statusBadge.text}</span>
        )}
        <button
          type="button"
          className="detail-close"
          onClick={() => selectDrone(null)}
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
          value={drone.label}
          onChange={(e) => set('label', e.target.value)}
        />
      </div>

      <div className="detail-row">
        <div className="detail-section">
          <label className="detail-label">
            Speed <span className="detail-unit">(m/s)</span>
          </label>
          <input
            type="number"
            className="detail-input mono"
            step="1"
            min="1"
            value={drone.speedMps}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (Number.isFinite(v) && v > 0) set('speedMps', v)
            }}
          />
        </div>
        <div className="detail-section">
          <label className="detail-label">
            Frequency <span className="detail-unit">(MHz)</span>
          </label>
          <input
            type="number"
            className="detail-input mono"
            step="10"
            min="100"
            value={drone.frequencyMhz}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (Number.isFinite(v) && v > 0) set('frequencyMhz', v)
            }}
          />
        </div>
      </div>

      <div className="detail-section">
        <label className="detail-label">
          SJR threshold <span className="detail-unit">(dB — drone link fails below this)</span>
        </label>
        <input
          type="number"
          className="detail-input mono"
          step="1"
          value={drone.sjrThresholdDb}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) set('sjrThresholdDb', v)
          }}
        />
      </div>

      <div className="detail-row">
        <div className="detail-section">
          <label className="detail-label">Start latitude</label>
          <div className="detail-input mono detail-readonly">{drone.start.latitude.toFixed(6)}°</div>
        </div>
        <div className="detail-section">
          <label className="detail-label">Start longitude</label>
          <div className="detail-input mono detail-readonly">
            {drone.start.longitude.toFixed(6)}°
          </div>
        </div>
      </div>

      <div className="detail-row">
        <div className="detail-section">
          <label className="detail-label">
            Waypoints <span className="detail-unit">(after start)</span>
          </label>
          <div className="detail-input mono detail-readonly">{drone.waypoints.length}</div>
        </div>
        <div className="detail-section">
          <label className="detail-label">
            Path length <span className="detail-unit">(m)</span>
          </label>
          <div className="detail-input mono detail-readonly">{totalPathM.toFixed(0)}</div>
        </div>
      </div>

      {drone.waypoints.length > 0 && (
        <div className="detail-section">
          <label className="detail-label">
            Estimated transit <span className="detail-unit">(s)</span>
          </label>
          <div className="detail-input mono detail-readonly">{etaSeconds.toFixed(1)}</div>
        </div>
      )}

      {runtime?.jammedBy && (
        <div className="detail-section">
          <label className="detail-label">
            Jamming readout <span className="detail-unit">(live)</span>
          </label>
          <div className="detail-input mono detail-readonly">
            SJR {runtime.sjrDb != null ? `${runtime.sjrDb.toFixed(1)} dB` : '?'}
            {' · '}
            jammer signal{' '}
            {runtime.jammerSignalDbm != null
              ? `${runtime.jammerSignalDbm.toFixed(1)} dBm`
              : '?'}
          </div>
        </div>
      )}

      <div className="detail-actions">
        <button
          type="button"
          className="detail-delete"
          onClick={() => removeDrone(drone.id)}
        >
          Delete drone
        </button>
      </div>
    </aside>
  )
}

function runtimeBadge(status: string | undefined):
  | { text: string; className: string }
  | null {
  switch (status) {
    case 'jammed':
      return { text: 'Jammed', className: 'jammed' }
    case 'intrusion':
      return { text: 'Intrusion', className: 'intrusion' }
    case 'finished':
      return { text: 'Reached target', className: 'finished' }
    case 'flying':
      return { text: 'Flying', className: 'flying' }
    default:
      return null
  }
}
