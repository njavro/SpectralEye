import { useStore } from '../store'
import type { Drone } from '../types'

export function SituationModelingPanel() {
  const open = useStore((s) => s.situationModelingOpen)
  const close = useStore((s) => () => s.setSituationModelingOpen(false))
  const placeMode = useStore((s) => s.placeMode)
  const setPlaceMode = useStore((s) => s.setPlaceMode)
  const finishDronePlanning = useStore((s) => s.finishDronePlanning)
  const drones = useStore((s) => s.drones)
  const selectedDroneId = useStore((s) => s.selectedDroneId)
  const selectDrone = useStore((s) => s.selectDrone)
  const removeDrone = useStore((s) => s.removeDrone)

  if (!open) return null

  const planning = placeMode === 'drone-plan'

  return (
    <aside className="situation-panel">
      <header className="situation-header">
        <span className="situation-title">Situation Modeling</span>
        <button type="button" className="detail-close" onClick={close} title="Close">
          ×
        </button>
      </header>

      <div className="situation-section">
        <div className="situation-section-label">Hostile drones</div>
        <button
          type="button"
          className={`palette-button${planning ? ' active' : ''}`}
          onClick={() => {
            if (planning) finishDronePlanning()
            else setPlaceMode('drone-plan')
          }}
        >
          <span className="palette-swatch" style={{ background: '#dc2626' }} />
          <span className="palette-label">
            {planning ? 'Finish Drone Plan' : 'Plan Drone Threat'}
          </span>
        </button>
        {planning && (
          <div className="palette-hint">
            First click sets the drone's spawn point. Subsequent clicks add waypoints
            to its trajectory. Press <kbd>Esc</kbd> or click "Finish Drone Plan" when done.
          </div>
        )}
      </div>

      {drones.length > 0 && (
        <div className="situation-section">
          <div className="situation-section-label">
            Planned drones <span className="palette-count">{drones.length}</span>
          </div>
          <ul className="drone-list">
            {drones.map((d) => (
              <DroneListItem
                key={d.id}
                drone={d}
                selected={d.id === selectedDroneId}
                onSelect={() => selectDrone(d.id)}
                onRemove={() => removeDrone(d.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}

type DroneListItemProps = {
  drone: Drone
  selected: boolean
  onSelect: () => void
  onRemove: () => void
}

function DroneListItem({ drone, selected, onSelect, onRemove }: DroneListItemProps) {
  return (
    <li className={`drone-list-item${selected ? ' selected' : ''}`}>
      <button type="button" className="drone-list-button" onClick={onSelect}>
        <span className="drone-list-label">{drone.label}</span>
        <span className="drone-list-meta">
          {drone.waypoints.length} wp · {drone.speedMps} m/s
        </span>
      </button>
      <button
        type="button"
        className="drone-list-delete"
        onClick={onRemove}
        title="Remove drone"
      >
        ×
      </button>
    </li>
  )
}
