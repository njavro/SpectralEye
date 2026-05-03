import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import { useStore } from '../store'
import {
  computeDronePosition,
  detectIntrusion,
  evaluateJamming,
} from './simulation'

// rAF-driven loop that advances simulation time, recomputes each drone's
// position/intrusion/SJR every frame, and writes results back to the store.
// Mounts inside the Cesium viewer tree (alongside DroneLayer / OoILayer)
// so it can pull `viewer` from useCesium and request renders directly.
//
// No JSX — purely an effects component.
export function SimulationRunner() {
  const { viewer } = useCesium()
  const status = useStore((s) => s.simulationStatus)
  const lastFrameRef = useRef<number | null>(null)
  // Latest store snapshot — refreshed every frame from useStore.getState() so
  // the rAF callback doesn't have to re-subscribe whenever drones / OoIs /
  // grids change. (Re-subscribing would tear down the rAF loop.)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (status !== 'running') {
      lastFrameRef.current = null
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    const tick = (now: number) => {
      const last = lastFrameRef.current
      lastFrameRef.current = now
      const dt = last == null ? 0 : Math.min(0.1, (now - last) / 1000)

      const s = useStore.getState()
      // Sim time advances regardless of how many drones are still moving — the
      // "finished" detection below short-circuits per-drone work for inactive
      // ones, so this stays cheap even with the loop ticking forever.
      const nextTime = s.simulationTime + dt
      s.setSimulationTime(nextTime)

      const offset = s.aoiGroundOffsetM ?? 0
      // Build the next runtime map all at once so React only re-renders
      // dependent layers ONCE per frame instead of N times (one per drone).
      const nextRuntime: Record<string, typeof s.droneRuntime[string]> = {}
      for (const drone of s.drones) {
        const rt = s.droneRuntime[drone.id]
        if (!rt) continue

        // Jammed drones freeze in place — only re-evaluate intrusion (a
        // drone jammed inside a perimeter still triggers the alarm). Position,
        // jammedBy, sjrDb stay locked at their first-jam values.
        if (rt.status === 'jammed') {
          const intruded = detectIntrusion(rt.position, s.ois)
          const nextOoi = intruded?.id ?? null
          nextRuntime[drone.id] = nextOoi !== rt.intrudedOoi ? { ...rt, intrudedOoi: nextOoi } : rt
          continue
        }

        const { position, finished } = computeDronePosition(drone, nextTime)
        const jamming = evaluateJamming(drone, position, s.assets, s.coverageGrids, offset)
        const intruded = detectIntrusion(position, s.ois)
        // Latch the alert: on an enter transition, record an event into the
        // store so the alert banner persists past the geometric breach (the
        // drone may exit the dome on the next waypoint or the run may finish
        // with a single fly-through). Cleared by "Situation mitigated" or
        // by Reset.
        if (intruded && intruded.id !== rt.intrudedOoi) {
          console.log(
            `[Sim] ${drone.label} ENTER ${intruded.label} → recordIntrusionEvent`,
          )
          s.recordIntrusionEvent({
            droneId: drone.id,
            droneLabel: drone.label,
            ooiId: intruded.id,
            ooiLabel: intruded.label,
            detectedAt: nextTime,
            frequencyMhz: drone.frequencyMhz,
          })
          console.log(
            `[Sim] events now: ${useStore.getState().unacknowledgedIntrusions.length}`,
          )
        }

        if (jamming.jammed && jamming.strongestJammerId) {
          nextRuntime[drone.id] = {
            ...rt,
            position,
            status: 'jammed',
            jammedBy: jamming.strongestJammerId,
            jammerSignalDbm: jamming.jammerSignalDbm,
            sjrDb: jamming.sjrDb,
            intrudedOoi: intruded?.id ?? null,
          }
          continue
        }

        nextRuntime[drone.id] = {
          ...rt,
          position,
          status: intruded ? 'intrusion' : finished ? 'finished' : 'flying',
          jammedBy: null,
          jammerSignalDbm: jamming.jammerSignalDbm,
          sjrDb: jamming.sjrDb,
          intrudedOoi: intruded?.id ?? null,
        }
      }
      s.setDroneRuntimeMap(nextRuntime)

      // Stop the loop once every drone is locked (jammed or finished) — the
      // rAF callback would otherwise keep ticking forever for no visible
      // change.
      const allLocked =
        s.drones.length > 0 &&
        s.drones.every((d) => {
          const r = nextRuntime[d.id]
          return r && (r.status === 'jammed' || r.status === 'finished')
        })
      if (allLocked) useStore.getState().setSimulationStatus('finished')

      if (viewer && !viewer.isDestroyed()) viewer.scene.requestRender()

      if (useStore.getState().simulationStatus === 'running') {
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [status, viewer])

  return null
}
