import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  CallbackProperty,
  Color,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Viewer,
} from 'cesium'
import type { Bbox } from '../types'

type Props = {
  enabled: boolean
  onDrawn: (bbox: Bbox) => void
  onCancel?: () => void
}

const PROV_BORDER_ID = 'spectraleye-aoi-provisional-border'

function pickLatLon(viewer: Viewer, x: number, y: number): { lon: number; lat: number } | null {
  const cartesian = viewer.camera.pickEllipsoid(new Cartesian2(x, y), viewer.scene.globe.ellipsoid)
  if (!cartesian) return null
  const c = Cartographic.fromCartesian(cartesian)
  return {
    lon: CesiumMath.toDegrees(c.longitude),
    lat: CesiumMath.toDegrees(c.latitude),
  }
}

function bboxFromCorners(a: { lon: number; lat: number }, b: { lon: number; lat: number }): Bbox {
  return [
    Math.min(a.lon, b.lon),
    Math.min(a.lat, b.lat),
    Math.max(a.lon, b.lon),
    Math.max(a.lat, b.lat),
  ]
}

function borderPositions(bbox: Bbox): Cartesian3[] {
  const [west, south, east, north] = bbox
  return Cartesian3.fromDegreesArray([
    west, south,
    east, south,
    east, north,
    west, north,
    west, south,
  ])
}

function removeProvisional(viewer: Viewer) {
  const e = viewer.entities.getById(PROV_BORDER_ID)
  if (e) {
    viewer.entities.remove(e)
    viewer.scene.requestRender()
  }
}

export function BboxPicker({ enabled, onDrawn, onCancel }: Props) {
  const { viewer } = useCesium()
  const startRef = useRef<{ lon: number; lat: number } | null>(null)
  // Mutated on every mousemove, read by the CallbackProperty each frame.
  // No entity rebuild on each move — just read this ref.
  const liveBboxRef = useRef<Bbox | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!viewer || !enabled) return
    console.log('[BboxPicker] activating draw mode')
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const controller = viewer.scene.screenSpaceCameraController
    controller.enableInputs = false

    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const start = pickLatLon(viewer, e.position.x, e.position.y)
      if (!start) return
      startRef.current = start
      liveBboxRef.current = [start.lon, start.lat, start.lon, start.lat]

      // Create the entity once. Positions are a CallbackProperty that reads
      // liveBboxRef each frame — zero entity churn during drag.
      if (!viewer.entities.getById(PROV_BORDER_ID)) {
        viewer.entities.add({
          id: PROV_BORDER_ID,
          polyline: {
            positions: new CallbackProperty(
              () => (liveBboxRef.current ? borderPositions(liveBboxRef.current) : []),
              false,
            ),
            width: 3,
            material: Color.fromCssColorString('rgba(140, 196, 255, 1.0)'),
            clampToGround: true,
          },
        })
      }
      viewer.scene.requestRender()
    }, ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => {
      if (!startRef.current) return
      const cur = pickLatLon(viewer, e.endPosition.x, e.endPosition.y)
      if (!cur) return
      liveBboxRef.current = bboxFromCorners(startRef.current, cur)
      // Throttle render requests to one per frame.
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null
          viewer.scene.requestRender()
        })
      }
    }, ScreenSpaceEventType.MOUSE_MOVE)

    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      if (!startRef.current) return
      const end = pickLatLon(viewer, e.position.x, e.position.y)
      const bbox = end ? bboxFromCorners(startRef.current, end) : null
      removeProvisional(viewer)
      startRef.current = null
      liveBboxRef.current = null
      if (bbox && bbox[2] - bbox[0] > 1e-4 && bbox[3] - bbox[1] > 1e-4) {
        console.log('[BboxPicker] drawn', bbox)
        onDrawn(bbox)
      }
    }, ScreenSpaceEventType.LEFT_UP)

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        startRef.current = null
        liveBboxRef.current = null
        removeProvisional(viewer)
        onCancel?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      handler.destroy()
      window.removeEventListener('keydown', onKeyDown)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      if (!viewer.isDestroyed()) {
        viewer.scene.screenSpaceCameraController.enableInputs = true
        removeProvisional(viewer)
      }
    }
  }, [viewer, enabled, onDrawn, onCancel])

  return null
}
