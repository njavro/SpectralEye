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
import {
  DEFAULT_DRONE_AGL_M,
  DEFAULT_OOI_PERIMETER_M,
  DRONE_BUILDING_CLEARANCE_M,
} from '../types'
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

// Compute the drone's flight altitude at a (lon, lat). Always at least
// DEFAULT_DRONE_AGL_M above terrain (so paths over hills follow the ground)
// AND DRONE_BUILDING_CLEARANCE_M above any building/tileset surface there
// (so a tall rooftop pushes the drone up rather than letting the trajectory
// spear through it). Falls back gracefully if a tile isn't loaded yet.
function computeDroneAltitude(viewer: Viewer, lon: number, lat: number): number {
  const cart = Cartographic.fromDegrees(lon, lat)
  // Globe height = terrain only (no tilesets). Synchronous, returns undefined
  // if the tile isn't loaded.
  const terrainH = viewer.scene.globe.getHeight(cart)
  // sampleHeight = highest of terrain + 3D Tiles, also synchronous.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const surfaceH = (viewer.scene as any).sampleHeight
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (viewer.scene as any).sampleHeight(cart)
    : undefined
  const ground = Number.isFinite(terrainH) ? (terrainH as number) : (surfaceH ?? 0)
  const top = Number.isFinite(surfaceH) ? (surfaceH as number) : ground
  return Math.max(ground + DEFAULT_DRONE_AGL_M, top + DRONE_BUILDING_CLEARANCE_M)
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
      // append waypoints. Altitude is computed from the actual terrain +
      // building heights at the waypoint, NOT from whatever surface
      // pickPosition happened to hit, so paths stay at a uniform AGL
      // regardless of whether the operator clicked on terrain or a roof.
      const wp = {
        longitude: surf.longitude,
        latitude: surf.latitude,
        height: computeDroneAltitude(viewer, surf.longitude, surf.latitude),
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
