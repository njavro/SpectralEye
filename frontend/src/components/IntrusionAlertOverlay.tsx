import { useStore } from '../store'
import type { Drone, ObjectOfInterest } from '../types'

// Top-mounted banner that screams when any drone is currently inside an SPoI
// safety perimeter. Auto-shows on intrusion, auto-clears when every drone is
// either back outside the dome or has been removed. Lists which drone
// breached which SPoI so the operator can identify the threat at a glance.
//
// Renders as a portal-style overlay outside the Cesium viewer tree — must be
// mounted at the root of the app so it sits above the 3D scene and panels.
export function IntrusionAlertOverlay() {
  const drones = useStore((s) => s.drones)
  const droneRuntime = useStore((s) => s.droneRuntime)
  const ois = useStore((s) => s.ois)

  const intrusions: Array<{ drone: Drone; ooi: ObjectOfInterest }> = []
  for (const drone of drones) {
    const rt = droneRuntime[drone.id]
    if (!rt?.intrudedOoi) continue
    const ooi = ois.find((o) => o.id === rt.intrudedOoi)
    if (!ooi) continue
    intrusions.push({ drone, ooi })
  }

  if (intrusions.length === 0) return null

  return (
    <div className="intrusion-alert" role="alert" aria-live="assertive">
      <div className="intrusion-alert-icon" aria-hidden="true">
        ⚠
      </div>
      <div className="intrusion-alert-content">
        <div className="intrusion-alert-title">
          CRITICAL WARNING — UNKNOWN ENTITY PENETRATED THE PERIMETER
        </div>
        <ul className="intrusion-alert-details">
          {intrusions.map(({ drone, ooi }) => (
            <li key={drone.id}>
              <strong>{drone.label}</strong> inside <strong>{ooi.label}</strong>
              {' · '}
              <span className="intrusion-alert-coord">
                {drone.frequencyMhz.toFixed(0)} MHz
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
