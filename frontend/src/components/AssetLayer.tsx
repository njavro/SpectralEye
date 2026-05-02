import { useEffect, useRef } from 'react'
import { useCesium } from 'resium'
import { Entity } from 'cesium'
import { useStore } from '../store'
import { visualFor } from './assetVisuals'
import type { Asset } from '../types'

// Renders all assets as Cesium entities. Subscribes to the store and rebuilds
// each asset's entity on change (cheap because asset count is small in v0.1).
export function AssetLayer() {
  const { viewer } = useCesium()
  const assets = useStore((s) => s.assets)
  const selectedId = useStore((s) => s.selectedAssetId)
  const knownIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!viewer) return

    const liveIds = new Set<string>()
    for (const a of assets) {
      liveIds.add(a.id)
      const visual = visualFor(a.type)
      const opts = visual.build(a, { selected: a.id === selectedId })

      const existing = viewer.entities.getById(a.id)
      if (existing) {
        viewer.entities.remove(existing)
      }
      viewer.entities.add(new Entity(opts))
    }

    // Remove entities for assets that no longer exist.
    for (const id of knownIds.current) {
      if (!liveIds.has(id)) {
        const e = viewer.entities.getById(id)
        if (e) viewer.entities.remove(e)
      }
    }
    knownIds.current = liveIds
    viewer.scene.requestRender()
  }, [viewer, assets, selectedId])

  // On unmount, sweep all asset entities so a Strict-Mode remount doesn't
  // leave duplicates behind.
  useEffect(() => {
    return () => {
      if (!viewer || viewer.isDestroyed()) return
      for (const id of knownIds.current) {
        const e = viewer.entities.getById(id)
        if (e) viewer.entities.remove(e)
      }
      knownIds.current = new Set()
    }
  }, [viewer])

  // Used by sibling components to know what we own — exported via a global ref pattern below.
  return null
}

// Helper exported for AssetInteraction to test entity ownership.
export function isAssetEntity(entity: { id?: unknown }): boolean {
  return typeof entity?.id === 'string' && entity.id.startsWith('asset-')
}

export type { Asset }
