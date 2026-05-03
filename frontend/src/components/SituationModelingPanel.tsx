import { useStore } from '../store'
import type { Asset, Drone, DroneRuntime } from '../types'

export function SituationModelingPanel() {
  const open = useStore((s) => s.situationModelingOpen)
  const setSituationModelingOpen = useStore((s) => s.setSituationModelingOpen)
  const placeMode = useStore((s) => s.placeMode)
  const setPlaceMode = useStore((s) => s.setPlaceMode)
  const finishDronePlanning = useStore((s) => s.finishDronePlanning)
  const drones = useStore((s) => s.drones)
  const droneRuntime = useStore((s) => s.droneRuntime)
  const assets = useStore((s) => s.assets)
  const selectedDroneId = useStore((s) => s.selectedDroneId)
  const selectDrone = useStore((s) => s.selectDrone)
  const removeDrone = useStore((s) => s.removeDrone)
  const simulationStatus = useStore((s) => s.simulationStatus)
  const simulationTime = useStore((s) => s.simulationTime)
  const startSimulation = useStore((s) => s.startSimulation)
  const pauseSimulation = useStore((s) => s.pauseSimulation)
  const resumeSimulation = useStore((s) => s.resumeSimulation)
  const resetSimulation = useStore((s) => s.resetSimulation)
  const contestedAirspaceVisible = useStore((s) => s.contestedAirspaceVisible)
  const toggleContestedAirspace = useStore((s) => s.toggleContestedAirspace)
  const jammerCount = useStore((s) => s.assets.filter((a) => a.type === 'jammer').length)

  if (!open) return null

  const planning = placeMode === 'drone-plan'
  const hasPlannedDrone = drones.some((d) => d.waypoints.length > 0)
  const sim = simulationStatus

  const onPrimaryClick = () => {
    if (sim === 'running') pauseSimulation()
    else if (sim === 'paused') resumeSimulation()
    else startSimulation()
  }
  const primaryLabel =
    sim === 'running' ? 'Pause' : sim === 'paused' ? 'Resume' : sim === 'finished' ? 'Re-run' : 'Run'

  return (
    <aside className="situation-panel">
      <header className="situation-header">
        <span className="situation-title">Situation Modeling</span>
        <button
          type="button"
          className="detail-close"
          onClick={() => setSituationModelingOpen(false)}
          title="Close"
        >
          ×
        </button>
      </header>

      <div className="situation-section">
        <div className="situation-section-label">Threat overlays</div>
        <button
          type="button"
          className={`palette-button${contestedAirspaceVisible ? ' active' : ''}`}
          onClick={toggleContestedAirspace}
          disabled={jammerCount === 0}
          title={
            jammerCount === 0
              ? 'Place a jammer (and Show EMS for it) to populate the contested volume'
              : 'Magenta volumes mark where a jammer can defeat a drone control link'
          }
        >
          <span className="palette-swatch" style={{ background: '#d946ef' }} />
          <span className="palette-label">
            {contestedAirspaceVisible ? 'Hide Contested Airspace' : 'Show Contested Airspace'}
          </span>
        </button>
      </div>

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
                runtime={droneRuntime[d.id]}
                jammer={
                  droneRuntime[d.id]?.jammedBy
                    ? assets.find((a) => a.id === droneRuntime[d.id]!.jammedBy) ?? null
                    : null
                }
                selected={d.id === selectedDroneId}
                onSelect={() => selectDrone(d.id)}
                onRemove={() => removeDrone(d.id)}
              />
            ))}
          </ul>
        </div>
      )}

      {drones.length > 0 && (
        <div className="situation-section">
          <div className="situation-section-label">
            Mission rehearsal{' '}
            <span className="sim-time mono">{simulationTime.toFixed(1)} s</span>
          </div>
          <div className="sim-controls">
            <button
              type="button"
              className={`primary-button sim-primary${sim === 'running' ? ' running' : ''}`}
              onClick={onPrimaryClick}
              disabled={!hasPlannedDrone}
              title={hasPlannedDrone ? '' : 'Add at least one waypoint to a drone first'}
            >
              {primaryLabel}
            </button>
            <button
              type="button"
              className="change-location"
              onClick={resetSimulation}
              disabled={sim === 'idle' && simulationTime === 0}
            >
              Reset
            </button>
          </div>
          <div className="palette-hint">
            Tip: click <em>Show EMS</em> on jammer assets before running so the
            simulation has coverage data to evaluate SJR. Drones freeze in place
            and a red link appears the moment a co-channel jammer overpowers
            them.
          </div>
        </div>
      )}
    </aside>
  )
}

type DroneListItemProps = {
  drone: Drone
  runtime: DroneRuntime | undefined
  jammer: Asset | null
  selected: boolean
  onSelect: () => void
  onRemove: () => void
}

function statusLine(rt: DroneRuntime | undefined, jammer: Asset | null): {
  text: string
  className: string
} {
  if (!rt) return { text: '', className: '' }
  if (rt.status === 'jammed') {
    const sjr = rt.sjrDb != null ? `SJR ${rt.sjrDb.toFixed(1)} dB` : 'SJR ?'
    const by = jammer ? jammer.label : 'unknown jammer'
    return { text: `Jammed by ${by} · ${sjr}`, className: 'drone-status jammed' }
  }
  if (rt.intrudedOoi) return { text: 'INTRUSION', className: 'drone-status intrusion' }
  if (rt.status === 'finished') return { text: 'Reached target', className: 'drone-status finished' }
  if (rt.sjrDb != null) {
    return { text: `Flying · SJR ${rt.sjrDb.toFixed(1)} dB`, className: 'drone-status flying' }
  }
  return { text: 'Flying · no jammer signal', className: 'drone-status flying' }
}

function DroneListItem({ drone, runtime, jammer, selected, onSelect, onRemove }: DroneListItemProps) {
  const status = statusLine(runtime, jammer)
  return (
    <li className={`drone-list-item${selected ? ' selected' : ''}`}>
      <button type="button" className="drone-list-button" onClick={onSelect}>
        <span className="drone-list-label">{drone.label}</span>
        <span className="drone-list-meta">
          {drone.waypoints.length} wp · {drone.speedMps} m/s
        </span>
        {status.text && <span className={status.className}>{status.text}</span>}
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
