import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import {
  Cartesian2,
  Cartographic,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Viewer,
} from 'cesium'
import { useStore } from '../store'
import { DEFAULT_DRONE_AGL_M, DEFAULT_OOI_PERIMETER_M } from '../types'
import type { Bbox } from '../types'

function pickSurface(viewer: Viewer, x: number, y: number) {
  const cart = viewer.scene.pickPosition(new Cartesian2(x, y))
  if (!cart) return null
  const c = Cartographic.fromCartesian(cart)
  return {
    longitude: CesiumMath.toDegrees(c.longitude),
    latitude: CesiumMath.toDegrees(c.latitude),
    height: c.height,
  }
}

function inBbox(lon: number, lat: number, bbox: Bbox): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
}

export function ThreatInteraction() {
  const { viewer } = useCesium()
  const placeMode = useStore((s) => s.placeMode)
  const aoi = useStore((s) => s.aoi)
  const drawMode = useStore((s) => s.drawMode)
  const aoiInitializing = useStore((s) => s.aoiInitializing)

  const placeModeRef = useRef(placeMode)
  const aoiRef = useRef(aoi)
  placeModeRef.current = placeMode
  aoiRef.current = aoi

  useEffect(() => {
    if (!viewer) return
    if (drawMode || aoiInitializing) return
    // Only listen for OoI / drone-plan clicks. Asset clicks are still handled
    // by AssetInteraction; we filter by placeMode.

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const store = useStore.getState

    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const pm = placeModeRef.current
      if (pm !== 'ooi' && pm !== 'drone-plan') return

      const surf = pickSurface(viewer, e.position.x, e.position.y)
      if (!surf) return
      const a = aoiRef.current
      if (a && !inBbox(surf.longitude, surf.latitude, a.bbox)) {
        console.log(`[ThreatInteraction] click outside AOI — rejected`)
        return
      }

      if (pm === 'ooi') {
        store().addOoi({
          longitude: surf.longitude,
          latitude: surf.latitude,
          height: surf.height,
          perimeterRadiusM: DEFAULT_OOI_PERIMETER_M,
        })
        return
      }

      // drone-plan flow: first click creates the drone, subsequent clicks
      // append waypoints.
      const wp = {
        longitude: surf.longitude,
        latitude: surf.latitude,
        height: surf.height + DEFAULT_DRONE_AGL_M,
      }
      const planningId = store().dronePlanningId
      if (!planningId) {
        store().addDrone(wp)
      } else {
        store().appendDroneWaypoint(planningId, wp)
      }
    }, ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      handler.destroy()
    }
  }, [viewer, drawMode, aoiInitializing])

  // Cursor feedback during OoI / drone placement.
  useEffect(() => {
    if (!viewer) return
    if (placeMode === 'ooi' || placeMode === 'drone-plan') {
      viewer.scene.canvas.style.cursor = 'crosshair'
    }
    return () => {
      if (viewer && !viewer.isDestroyed() && (placeMode === 'ooi' || placeMode === 'drone-plan')) {
        viewer.scene.canvas.style.cursor = ''
      }
    }
  }, [viewer, placeMode])

  // Esc finishes drone planning or exits OoI placement.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const s = useStore.getState()
      if (s.placeMode === 'drone-plan') {
        s.finishDronePlanning()
      } else if (s.placeMode === 'ooi') {
        s.setPlaceMode(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return null
}
