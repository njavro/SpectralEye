import { useStore } from '../store'

// Top-mounted critical alert that latches once any drone has breached an SPoI
// safety perimeter. Stays visible until the operator clicks "Situation
// mitigated" — even after the drone exits the dome or the simulation
// finishes — because a brief fly-through is exactly the case where the alert
// must NOT vanish before the operator notices it. Reset also clears the
// latch so a fresh run starts clean.
//
// Renders as a portal-style overlay outside the Cesium viewer tree — must be
// mounted at the root of the app so it sits above the 3D scene and panels.
export function IntrusionAlertOverlay() {
  const events = useStore((s) => s.unacknowledgedIntrusions)
  const clear = useStore((s) => s.clearIntrusionEvents)

  if (events.length === 0) return null

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
          {events.map((ev) => (
            <li key={`${ev.droneId}::${ev.ooiId}`}>
              <strong>{ev.droneLabel}</strong> breached <strong>{ev.ooiLabel}</strong>
              {' · '}
              <span className="intrusion-alert-coord">
                T+{ev.detectedAt.toFixed(1)}s · {ev.frequencyMhz.toFixed(0)} MHz
              </span>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="intrusion-alert-mitigate"
        onClick={clear}
        title="Acknowledge and dismiss the alert"
      >
        Situation Mitigated
      </button>
    </div>
  )
}
