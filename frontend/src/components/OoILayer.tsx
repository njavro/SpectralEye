import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import {
  Cartesian3,
  Color,
  Entity,
  HeightReference,
  HorizontalOrigin,
  LabelStyle,
  Math as CesiumMath,
  VerticalOrigin,
} from 'cesium'
import { useStore } from '../store'
import { OOI_COLOR } from './threatVisuals'

const ID_PREFIX = 'ooi'

export function OoILayer() {
  const { viewer } = useCesium()
  const ois = useStore((s) => s.ois)
  const selectedId = useStore((s) => s.selectedOoiId)
  const droneRuntime = useStore((s) => s.droneRuntime)
  const known = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!viewer) return

    // OoI ids currently breached by at least one drone — drives the alarm
    // coloring on the dome (red fill + red edge). Recomputed each render
    // from the runtime map; cheap since drone count is small.
    const alarmedIds = new Set<string>()
    for (const rt of Object.values(droneRuntime)) {
      if (rt.intrudedOoi) alarmedIds.add(rt.intrudedOoi)
    }

    const live = new Set(ois.map((o) => o.id))

    // Drop entities for OoIs that no longer exist.
    for (const id of known.current) {
      if (!live.has(id)) {
        for (const sub of ['marker', 'perimeter', 'label']) {
          const e = viewer.entities.getById(`${ID_PREFIX}-${id}-${sub}`)
          if (e) viewer.entities.remove(e)
        }
      }
    }

    for (const ooi of ois) {
      const isSelected = ooi.id === selectedId
      const isAlarmed = alarmedIds.has(ooi.id)
      const center = Cartesian3.fromDegrees(ooi.longitude, ooi.latitude, ooi.height + 2)

      // Marker (small upward tetrahedron — using cylinder with small bottom radius).
      const markerId = `${ID_PREFIX}-${ooi.id}-marker`
      let marker = viewer.entities.getById(markerId)
      if (!marker) {
        marker = new Entity({
          id: markerId,
          position: center,
          cylinder: {
            length: 18,
            topRadius: 0,
            bottomRadius: 6,
            material: Color.fromCssColorString(OOI_COLOR.marker).withAlpha(0.95),
            outline: true,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
          },
          label: {
            text: ooi.label,
            font: '13px -apple-system, sans-serif',
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            style: LabelStyle.FILL_AND_OUTLINE,
            horizontalOrigin: HorizontalOrigin.CENTER,
            verticalOrigin: VerticalOrigin.BOTTOM,
            pixelOffset: new Cartesian3(0, -10, 0),
            heightReference: HeightReference.NONE,
            showBackground: isSelected,
          },
        })
        viewer.entities.add(marker)
      } else {
        marker.position = center as unknown as Entity['position']
      }

      // Perimeter dome — top hemisphere of an ellipsoid sized to the perimeter
      // radius. Center sits at ground level (ooi.height) so only the top half
      // (cone 0 → π/2) renders, giving a dome rising from the ground.
      const perimId = `${ID_PREFIX}-${ooi.id}-perimeter`
      const perimCenter = Cartesian3.fromDegrees(ooi.longitude, ooi.latitude, ooi.height)
      const perimRadii = new Cartesian3(
        ooi.perimeterRadiusM,
        ooi.perimeterRadiusM,
        ooi.perimeterRadiusM,
      )
      let perim = viewer.entities.getById(perimId)
      const fillColor = Color.fromCssColorString(
        isAlarmed ? OOI_COLOR.perimeterFillAlarm : OOI_COLOR.perimeterFill,
      )
      const edgeColor = Color.fromCssColorString(
        isAlarmed ? OOI_COLOR.perimeterEdgeAlarm : OOI_COLOR.perimeterEdge,
      )
      if (!perim) {
        perim = new Entity({
          id: perimId,
          position: perimCenter,
          ellipsoid: {
            radii: perimRadii,
            material: fillColor,
            outline: true,
            outlineColor: edgeColor,
            outlineWidth: isAlarmed ? 2 : 1,
            slicePartitions: 24,
            stackPartitions: 16,
            maximumCone: CesiumMath.PI_OVER_TWO, // top hemisphere only
          },
        })
        viewer.entities.add(perim)
      } else {
        perim.position = perimCenter as unknown as Entity['position']
        if (perim.ellipsoid) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = perim.ellipsoid as any
          e.radii = perimRadii
          e.material = fillColor
          e.outlineColor = edgeColor
        }
      }

      known.current.add(ooi.id)
    }

    // Garbage-collect stale ids from known set.
    for (const id of Array.from(known.current)) {
      if (!live.has(id)) known.current.delete(id)
    }
    viewer.scene.requestRender()
  }, [viewer, ois, selectedId, droneRuntime])

  // Sweep on unmount.
  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) return
      for (const id of Array.from(known.current)) {
        for (const sub of ['marker', 'perimeter', 'label']) {
          const e = viewer.entities.getById(`${ID_PREFIX}-${id}-${sub}`)
          if (e) viewer.entities.remove(e)
        }
      }
      known.current.clear()
    }
  }, [viewer])

  return null
}
