import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import {
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
import type { Drone } from '../types'

const ID_PREFIX = 'drone'

function pathPositions(drone: Drone): Cartesian3[] {
  const pts = [drone.start, ...drone.waypoints]
  return pts.map((p) => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height))
}

export function DroneLayer() {
  const { viewer } = useCesium()
  const drones = useStore((s) => s.drones)
  const selectedId = useStore((s) => s.selectedDroneId)
  const planningId = useStore((s) => s.dronePlanningId)
  const known = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!viewer) return

    const live = new Set(drones.map((d) => d.id))
    for (const id of known.current) {
      if (!live.has(id)) {
        for (const sub of ['marker', 'path', 'wps']) {
          const e = viewer.entities.getById(`${ID_PREFIX}-${id}-${sub}`)
          if (e) viewer.entities.remove(e)
        }
      }
    }

    for (const drone of drones) {
      const isSelected = drone.id === selectedId
      const isPlanning = drone.id === planningId

      // Marker at the drone's current "logical" position (start until animated).
      const startPos = Cartesian3.fromDegrees(drone.start.longitude, drone.start.latitude, drone.start.height)
      const markerId = `${ID_PREFIX}-${drone.id}-marker`
      let marker = viewer.entities.getById(markerId)
      if (!marker) {
        marker = new Entity({
          id: markerId,
          position: startPos,
          cylinder: {
            length: 8,
            topRadius: 3,
            bottomRadius: 3,
            material: Color.fromCssColorString(DRONE_COLOR.clear).withAlpha(0.95),
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
      }

      // Path polyline (start → wp1 → wp2 → ...). Dashed while planning so the
      // operator sees that they're still in waypoint-add mode.
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

      known.current.add(drone.id)
    }

    for (const id of Array.from(known.current)) {
      if (!live.has(id)) known.current.delete(id)
    }
    viewer.scene.requestRender()
  }, [viewer, drones, selectedId, planningId])

  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) return
      for (const id of Array.from(known.current)) {
        for (const sub of ['marker', 'path']) {
          const e = viewer.entities.getById(`${ID_PREFIX}-${id}-${sub}`)
          if (e) viewer.entities.remove(e)
        }
      }
      known.current.clear()
    }
  }, [viewer])

  return null
}
