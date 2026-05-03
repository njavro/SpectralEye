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
import { defaultAssetParams } from '../types'
import type { AssetType, Bbox } from '../types'
import { isInWater, requiresLand } from './placementRules'

const ASSET_TYPES: ReadonlySet<string> = new Set(['jammer', 'sensor', 'relay'])

const SURFACE_OFFSET_M = 1.5

function pickSurface(viewer: Viewer, x: number, y: number) {
  // pickPosition reads the depth buffer — returns world coords of whatever is
  // visible at (x, y), which automatically accounts for terrain AND 3D tilesets
  // (so it tracks rooftops on top of OSM Buildings).
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

export function AssetInteraction() {
  const { viewer } = useCesium()
  const placeMode = useStore((s) => s.placeMode)
  const selectedAssetId = useStore((s) => s.selectedAssetId)
  const aoi = useStore((s) => s.aoi)
  const drawMode = useStore((s) => s.drawMode)
  const aoiInitializing = useStore((s) => s.aoiInitializing)

  const placeModeRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const aoiRef = useRef(aoi)

  placeModeRef.current = placeMode
  selectedIdRef.current = selectedAssetId
  aoiRef.current = aoi

  useEffect(() => {
    if (!viewer) return
    if (drawMode || aoiInitializing) return

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const store = useStore.getState()

    handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const pm = placeModeRef.current
      // Only act for asset placement modes (jammer/sensor/relay). OoI and
      // drone-plan modes are handled by ThreatInteraction.
      if (pm && ASSET_TYPES.has(pm)) {
        const assetPm = pm as AssetType
        const surf = pickSurface(viewer, e.position.x, e.position.y)
        if (!surf) return
        const a = aoiRef.current
        if (a && !inBbox(surf.longitude, surf.latitude, a.bbox)) {
          console.log('[AssetInteraction] click outside AOI — rejected')
          return
        }
        if (requiresLand(assetPm)) {
          const water = useStore.getState().waterPolygons ?? []
          if (isInWater(surf.longitude, surf.latitude, water)) {
            console.log(`[AssetInteraction] ${assetPm} requires land — click was over water, rejected`)
            return
          }
        }
        store.addAsset({
          type: assetPm,
          longitude: surf.longitude,
          latitude: surf.latitude,
          height: surf.height + SURFACE_OFFSET_M,
          ...defaultAssetParams(assetPm),
        })
        return
      }
      if (pm) return // OoI / drone-plan — let ThreatInteraction handle

      // Selection-only flow (no drag). Route by id prefix.
      const picked = viewer.scene.pick(e.position) as { id?: { id?: string } } | undefined
      const pickedId = picked?.id?.id
      if (typeof pickedId === 'string') {
        if (pickedId.startsWith('asset-')) {
          store.selectAsset(pickedId)
          return
        }
        // Drone marker/path/wps entities use prefix 'drone-<id>-...'
        const droneMatch = pickedId.match(/^drone-([^-]+(?:-\d+)?)-/)
        if (droneMatch) {
          // Reconstruct full drone id from store (entity ids embed the full one).
          const matched = useStore
            .getState()
            .drones.find((d) => pickedId.startsWith(`drone-${d.id}-`))
          if (matched) {
            store.selectDrone(matched.id)
            return
          }
        }
        const ooiMatch = pickedId.match(/^ooi-([^-]+(?:-\d+)?)-/)
        if (ooiMatch) {
          const matched = useStore
            .getState()
            .ois.find((o) => pickedId.startsWith(`ooi-${o.id}-`))
          if (matched) {
            store.selectOoi(matched.id)
            return
          }
        }
      }
      // Click on empty space → deselect everything.
      if (
        useStore.getState().selectedAssetId
        || useStore.getState().selectedDroneId
        || useStore.getState().selectedOoiId
      ) {
        store.selectAsset(null)
        store.selectDrone(null)
        store.selectOoi(null)
      }
    }, ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      handler.destroy()
    }
  }, [viewer, drawMode, aoiInitializing])

  // Cursor feedback during place mode.
  useEffect(() => {
    if (!viewer) return
    const canvas = viewer.scene.canvas
    canvas.style.cursor = placeMode ? 'crosshair' : ''
    return () => {
      if (!viewer.isDestroyed()) viewer.scene.canvas.style.cursor = ''
    }
  }, [viewer, placeMode])

  // Delete removes the selected asset; Esc cancels place mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = selectedIdRef.current
        if (id) {
          const target = e.target as HTMLElement | null
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
          useStore.getState().removeAsset(id)
        }
      } else if (e.key === 'Escape' && placeModeRef.current) {
        useStore.getState().setPlaceMode(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return null
}
