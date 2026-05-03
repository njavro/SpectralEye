import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import {
  CallbackProperty,
  Cartesian3,
  Color,
  Entity,
  HorizontalOrigin,
  LabelStyle,
  PolylineDashMaterialProperty,
  VerticalOrigin,
} from 'cesium'
import { useStore } from '../store'
import { DRONE_COLOR, TRAJECTORY_COLOR } from './threatVisuals'
import type { Drone, DroneRuntime } from '../types'

const ID_PREFIX = 'drone'

function pathPositions(drone: Drone): Cartesian3[] {
  const pts = [drone.start, ...drone.waypoints]
  return pts.map((p) => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height))
}

function colorForStatus(rt: DroneRuntime | undefined, isSelected: boolean): Color {
  if (!rt) return Color.fromCssColorString(DRONE_COLOR.clear)
  // Intrusion is the most operationally critical state — red overrides jammed.
  if (rt.intrudedOoi) return Color.fromCssColorString(DRONE_COLOR.intrusion)
  if (rt.status === 'jammed') return Color.fromCssColorString(DRONE_COLOR.jammed)
  return Color.fromCssColorString(DRONE_COLOR.clear).withAlpha(isSelected ? 1.0 : 0.95)
}

export function DroneLayer() {
  const { viewer } = useCesium()
  const drones = useStore((s) => s.drones)
  const droneRuntime = useStore((s) => s.droneRuntime)
  const assets = useStore((s) => s.assets)
  const selectedId = useStore((s) => s.selectedDroneId)
  const planningId = useStore((s) => s.dronePlanningId)
  const known = useRef<Set<string>>(new Set())
  // Per-drone live Cartesian — each entity reads from this map via a
  // CallbackProperty so Cesium re-evaluates the position every frame.
  // Assigning a raw Cartesian3 to entity.position works for labels but does
  // NOT trigger cylinder-geometry re-renders (the cylinder visualizer needs
  // a proper PositionProperty), which is why the label was drifting away
  // from a stuck cylinder.
  const dronePosRef = useRef<Map<string, Cartesian3>>(new Map())
  const jamLinkRef = useRef<Map<string, [Cartesian3, Cartesian3]>>(new Map())

  useEffect(() => {
    if (!viewer) return

    const live = new Set(drones.map((d) => d.id))
    const SUB_IDS = ['marker', 'path', 'jamlink']
    for (const id of known.current) {
      if (!live.has(id)) {
        for (const sub of SUB_IDS) {
          const e = viewer.entities.getById(`${ID_PREFIX}-${id}-${sub}`)
          if (e) viewer.entities.remove(e)
        }
        dronePosRef.current.delete(id)
        jamLinkRef.current.delete(id)
      }
    }

    for (const drone of drones) {
      const isSelected = drone.id === selectedId
      const isPlanning = drone.id === planningId
      const rt = droneRuntime[drone.id]
      const livePos = rt?.position ?? drone.start
      const markerCart = Cartesian3.fromDegrees(livePos.longitude, livePos.latitude, livePos.height)
      // Push the latest position into the ref BEFORE the visualizer reads it.
      // The CallbackProperty below pulls from this ref every frame.
      dronePosRef.current.set(drone.id, markerCart)

      // ---- Marker (cylinder) at the drone's current runtime position ----
      const markerColor = colorForStatus(rt, isSelected)
      const markerId = `${ID_PREFIX}-${drone.id}-marker`
      let marker = viewer.entities.getById(markerId)
      if (!marker) {
        // Capture id once for the closure — drone.id is stable for the entity's lifetime.
        const droneId = drone.id
        const positionProperty = new CallbackProperty(
          () => dronePosRef.current.get(droneId) ?? markerCart,
          false, // not constant — re-evaluate every frame
        )
        marker = new Entity({
          id: markerId,
          position: positionProperty,
          cylinder: {
            length: 8,
            topRadius: 3,
            bottomRadius: 3,
            material: markerColor,
            outline: true,
            outlineColor: Color.WHITE,
            outlineWidth: isSelected ? 3 : 1,
          },
          label: {
            text: drone.label,
            font: '13px -apple-system, sans-serif',
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            style: LabelStyle.FILL_AND_OUTLINE,
            horizontalOrigin: HorizontalOrigin.CENTER,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian3(0, -10, 0),
            showBackground: isSelected || isPlanning,
          },
        })
        viewer.entities.add(marker)
      } else if (marker.cylinder) {
        // Position auto-updates via the CallbackProperty + ref. Only material
        // and selection styling need a per-render write.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(marker.cylinder as any).material = markerColor
      }

      // ---- Planned path polyline (start → waypoints) ----
      const pathId = `${ID_PREFIX}-${drone.id}-path`
      const positions = pathPositions(drone)
      let path = viewer.entities.getById(pathId)
      if (positions.length >= 2) {
        const material = isPlanning
          ? new PolylineDashMaterialProperty({
              color: Color.fromCssColorString(TRAJECTORY_COLOR.planned),
              dashLength: 12,
            })
          : Color.fromCssColorString(TRAJECTORY_COLOR.planned)
        if (!path || !path.polyline) {
          if (path) viewer.entities.remove(path)
          path = new Entity({
            id: pathId,
            polyline: { positions, width: 2, material, clampToGround: false },
          })
          viewer.entities.add(path)
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(path.polyline as any).positions = positions
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(path.polyline as any).material = material
        }
      } else if (path) {
        viewer.entities.remove(path)
      }

      // ---- Jamming link (red line jammer → drone) ----
      // Drawn whenever the runtime says this drone is jammed and we can find
      // the offending asset. Same CallbackProperty trick as the marker so the
      // line endpoints follow the drone if it gets moved post-jam (e.g. a
      // future "you can drag a jammed drone to free it" feature).
      const jamId = `${ID_PREFIX}-${drone.id}-jamlink`
      const jammer = rt?.jammedBy ? assets.find((a) => a.id === rt.jammedBy) : null
      let jamLink = viewer.entities.getById(jamId)
      if (jammer && rt) {
        const jamFrom = Cartesian3.fromDegrees(jammer.longitude, jammer.latitude, jammer.height + 4)
        jamLinkRef.current.set(drone.id, [jamFrom, markerCart])
        const linkMaterial = new PolylineDashMaterialProperty({
          color: Color.fromCssColorString('#ef4444'),
          dashLength: 18,
          gapColor: Color.TRANSPARENT,
        })
        if (!jamLink || !jamLink.polyline) {
          if (jamLink) viewer.entities.remove(jamLink)
          const droneId = drone.id
          const positionsProperty = new CallbackProperty(
            () => jamLinkRef.current.get(droneId) ?? [jamFrom, markerCart],
            false,
          )
          jamLink = new Entity({
            id: jamId,
            polyline: {
              positions: positionsProperty,
              width: 3,
              material: linkMaterial,
              clampToGround: false,
            },
          })
          viewer.entities.add(jamLink)
        } else if (jamLink.polyline) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(jamLink.polyline as any).material = linkMaterial
        }
      } else if (jamLink) {
        viewer.entities.remove(jamLink)
        jamLinkRef.current.delete(drone.id)
      }

      known.current.add(drone.id)
    }

    for (const id of Array.from(known.current)) {
      if (!live.has(id)) known.current.delete(id)
    }
    viewer.scene.requestRender()
  }, [viewer, drones, droneRuntime, assets, selectedId, planningId])

  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) return
      for (const id of Array.from(known.current)) {
        for (const sub of ['marker', 'path', 'jamlink']) {
          const e = viewer.entities.getById(`${ID_PREFIX}-${id}-${sub}`)
          if (e) viewer.entities.remove(e)
        }
      }
      known.current.clear()
    }
  }, [viewer])

  return null
}
