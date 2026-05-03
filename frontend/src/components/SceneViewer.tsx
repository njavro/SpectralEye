import { useEffect, useRef } from 'react'
import { Viewer, useCesium } from 'resium'
import {
  BoundingSphere,
  Cartesian3,
  Cesium3DTileset,
  Cesium3DTileStyle,
  ClippingPolygon,
  ClippingPolygonCollection,
  Color,
  ConstantProperty,
  HeadingPitchRange,
  Math as CesiumMath,
  Terrain,
  type Viewer as CesiumViewer,
} from 'cesium'
import type { AreaOfOperation, Bbox } from '../types'
import { BboxPicker } from './BboxPicker'
import { AssetLayer } from './AssetLayer'
import { AssetInteraction } from './AssetInteraction'
import { ContestedAirspaceLayer } from './ContestedAirspaceLayer'
import { CoverageLayer } from './CoverageLayer'
import { DeploymentImporter } from './DeploymentImporter'
import { DroneLayer } from './DroneLayer'
import { OoILayer } from './OoILayer'
import { SimulationRunner } from './SimulationRunner'
import { ThreatInteraction } from './ThreatInteraction'

type Props = {
  aoi: AreaOfOperation | null
  drawMode: boolean
  onBboxDrawn: (bbox: Bbox) => void
  onCancelDraw: () => void
  onAoiBuildingsReady: () => void
}

const DEFAULT_LOCATION = {
  longitude: -122.4194,
  latitude: 37.7749,
  altitude: 3500,
  headingDeg: 25,
  pitchDeg: -30,
}

const AOI_BORDER_ID = 'spectraleye-aoi-border'

const VIEW_PITCH_DEG = -30
const VIEW_HEADING_DEG = 25
const MAX_LOAD_TIMEOUT_MS = 25_000

const BUILDING_STYLE = new Cesium3DTileStyle({
  color: {
    conditions: [
      ['${feature["building"]} === "industrial"', 'color("#a8b3bd")'],
      ['${feature["building"]} === "commercial"', 'color("#bfc9d2")'],
      ['${feature["building"]} === "residential"', 'color("#c9cfd6")'],
      ['true', 'color("#bcc4cc")'],
    ],
  },
})

function setInitialView(viewer: CesiumViewer) {
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(
      DEFAULT_LOCATION.longitude,
      DEFAULT_LOCATION.latitude,
      DEFAULT_LOCATION.altitude,
    ),
    orientation: {
      heading: CesiumMath.toRadians(DEFAULT_LOCATION.headingDeg),
      pitch: CesiumMath.toRadians(DEFAULT_LOCATION.pitchDeg),
      roll: 0,
    },
  })
}

function flyToAoi(viewer: CesiumViewer, bbox: Bbox): Promise<void> {
  const [west, south, east, north] = bbox
  const centerLon = (west + east) / 2
  const centerLat = (south + north) / 2
  const widthM = (east - west) * 111_320 * Math.cos((centerLat * Math.PI) / 180)
  const heightM = (north - south) * 111_320
  const diagonalM = Math.hypot(widthM, heightM)

  // Build a bounding sphere over the AOI center at ground level. flyToBoundingSphere
  // with HeadingPitchRange positions the camera at `range` away from the center
  // and orients it to look AT the center — so the AOI is centered in the viewport.
  const center = Cartesian3.fromDegrees(centerLon, centerLat, 0)
  const radiusM = diagonalM / 2
  const sphere = new BoundingSphere(center, radiusM)
  // range ≈ radius × 2.6 puts the AOI at about 60–70% of the viewport at default FOV,
  // pitched -30° (camera looks down-toward-center from above and behind).
  const range = Math.max(2000, Math.min(20_000, radiusM * 2.6))

  return new Promise((resolve) => {
    viewer.camera.cancelFlight()
    viewer.camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(
        CesiumMath.toRadians(VIEW_HEADING_DEG),
        CesiumMath.toRadians(VIEW_PITCH_DEG),
        range,
      ),
      duration: 1.4,
      complete: () => resolve(),
      cancel: () => resolve(),
    })
  })
}

function bboxClippingPolygons(bbox: Bbox): ClippingPolygonCollection {
  const [west, south, east, north] = bbox
  const positions = Cartesian3.fromDegreesArray([
    west, south,
    east, south,
    east, north,
    west, north,
  ])
  return new ClippingPolygonCollection({
    polygons: [new ClippingPolygon({ positions })],
    // inverse: true → keep only the interior visible (clip everything outside).
    inverse: true,
  })
}

function bboxBorderPositions(bbox: Bbox): Cartesian3[] {
  const [west, south, east, north] = bbox
  return Cartesian3.fromDegreesArray([
    west, south,
    east, south,
    east, north,
    west, north,
    west, south,
  ])
}

function setAoiBorder(viewer: CesiumViewer, bbox: Bbox) {
  const borderColor = Color.fromCssColorString('rgba(140, 196, 255, 1.0)')
  const existing = viewer.entities.getById(AOI_BORDER_ID)
  if (existing && existing.polyline) {
    existing.polyline.positions = new ConstantProperty(bboxBorderPositions(bbox))
  } else {
    viewer.entities.add({
      id: AOI_BORDER_ID,
      polyline: {
        positions: bboxBorderPositions(bbox),
        width: 3,
        material: borderColor,
        clampToGround: true,
      },
    })
  }
  viewer.scene.requestRender()
}

function clearAoiBorder(viewer: CesiumViewer) {
  const e = viewer.entities.getById(AOI_BORDER_ID)
  if (e) {
    viewer.entities.remove(e)
    viewer.scene.requestRender()
  }
}

function SceneSetup({ aoi, drawMode, onBboxDrawn, onCancelDraw, onAoiBuildingsReady }: Props) {
  const { viewer } = useCesium()
  const tilesetRef = useRef<Cesium3DTileset | null>(null)
  // Optional Google Photorealistic 3D Tiles overlay — purely cosmetic, has
  // zero impact on RF propagation (Sionna runs server-side off OSM polygons).
  // Enabled by setting VITE_GOOGLE_MAP_TILES_API_KEY in frontend/.env. When
  // active, the OSM Buildings tileset is hidden inside the AOI so the two
  // don't double up.
  const photoTilesetRef = useRef<Cesium3DTileset | null>(null)
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!viewer || initializedRef.current) return
    initializedRef.current = true
    const v = viewer

    v.scene.requestRenderMode = true
    v.scene.maximumRenderTimeChange = Infinity
    v.resolutionScale = 1.0
    // Render at the actual device pixel ratio (e.g., 2× on retina) instead of
    // scaled CSS pixels — biggest single perceived-sharpness win on Mac displays.
    v.useBrowserRecommendedResolution = false
    // Loose SSE pre-AOI → snappy startup; tightened to 1 once AOI is committed.
    v.scene.globe.maximumScreenSpaceError = 6
    // Big tile cache so detail tiles aren't evicted as the camera moves around the AOI.
    v.scene.globe.tileCacheSize = 1000
    // FXAA blurs textures; swap to MSAA (hardware multisample) for crisp geometry
    // edges without softening the imagery.
    if (v.scene.postProcessStages.fxaa) v.scene.postProcessStages.fxaa.enabled = false
    v.scene.msaaSamples = 4

    v.scene.setTerrain(Terrain.fromWorldTerrain())
    v.scene.globe.depthTestAgainstTerrain = true
    v.scene.globe.enableLighting = true

    // Neutralize the void outside the clipped AOI — kill stars/sun/moon and use a
    // flat dark backdrop instead of Cesium's astronomical skybox.
    if (v.scene.skyBox) v.scene.skyBox.show = false
    if (v.scene.sun) v.scene.sun.show = false
    if (v.scene.moon) v.scene.moon.show = false
    if (v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = false
    v.scene.backgroundColor = Color.fromCssColorString('#0a0d12')

    setInitialView(v)

    Cesium3DTileset.fromIonAssetId(96188)
      .then((tileset) => {
        if (v.isDestroyed()) return
        tileset.style = BUILDING_STYLE
        tileset.show = false
        // SSE 1 = most aggressive detail. Combined with bbox clipping and a tight
        // AOI, the bounded set of LOD 14-18 tiles all load once and stay cached.
        tileset.maximumScreenSpaceError = 1
        tileset.cacheBytes = 2_147_483_648 // 2 GB
        tileset.preloadWhenHidden = true
        v.scene.primitives.add(tileset)
        tilesetRef.current = tileset
        v.scene.requestRender()
        console.log('[SpectralEye] OSM Buildings tileset registered')
      })
      .catch((err) => {
        console.error('[SpectralEye] failed to load OSM Buildings', err)
      })

    // Optional Google Photorealistic 3D Tiles. Only loaded when the operator
    // has set VITE_GOOGLE_MAP_TILES_API_KEY — otherwise the scene falls back
    // to OSM Buildings and looks identical to before.
    const googleApiKey = import.meta.env.VITE_GOOGLE_MAP_TILES_API_KEY as string | undefined
    if (googleApiKey) {
      Cesium3DTileset.fromUrl(
        `https://tile.googleapis.com/v1/3dtiles/root.json?key=${googleApiKey}`,
        // Google's terms require attribution to be visible; Cesium handles it.
        { showCreditsOnScreen: true },
      )
        .then((tileset) => {
          if (v.isDestroyed()) return
          tileset.show = false
          tileset.maximumScreenSpaceError = 8
          tileset.cacheBytes = 1_073_741_824 // 1 GB
          tileset.preloadWhenHidden = true
          v.scene.primitives.add(tileset)
          photoTilesetRef.current = tileset
          v.scene.requestRender()
          console.log('[SpectralEye] Google Photorealistic 3D Tiles registered')
        })
        .catch((err) => {
          console.error('[SpectralEye] failed to load Google Photorealistic Tiles', err)
        })
    } else {
      console.log(
        '[SpectralEye] VITE_GOOGLE_MAP_TILES_API_KEY not set — using OSM Buildings only',
      )
    }
  }, [viewer])

  // AOI lifecycle: clip globe + clip buildings + fly camera + wait for tiles.
  useEffect(() => {
    if (!viewer) return

    if (!aoi) {
      clearAoiBorder(viewer)
      viewer.scene.globe.clippingPolygons = new ClippingPolygonCollection()
      // Relax terrain detail back to startup level when AOI is cleared.
      viewer.scene.globe.maximumScreenSpaceError = 6
      const t = tilesetRef.current
      if (t) {
        t.show = false
        t.clippingPolygons = new ClippingPolygonCollection()
      }
      const pt = photoTilesetRef.current
      if (pt) {
        pt.show = false
        pt.clippingPolygons = new ClippingPolygonCollection()
      }
      viewer.scene.requestRender()
      return
    }

    // Cut the globe to just the AOI — outside becomes empty atmosphere/void.
    viewer.scene.globe.clippingPolygons = bboxClippingPolygons(aoi.bbox)
    // Force max terrain detail inside the AOI; the 1000-tile cache will keep
    // the loaded detail in memory as the camera pans around within the AOI.
    viewer.scene.globe.maximumScreenSpaceError = 1
    setAoiBorder(viewer, aoi.bbox)

    const pt = photoTilesetRef.current
    const t = tilesetRef.current
    if (pt) {
      // Photorealistic available → it owns the buildings inside the AOI.
      // Hide the OSM tileset to avoid double-rendering.
      pt.show = true
      pt.clippingPolygons = bboxClippingPolygons(aoi.bbox)
      if (t) {
        t.show = false
        t.clippingPolygons = bboxClippingPolygons(aoi.bbox)
      }
    } else if (t) {
      // No photorealistic tileset → fall back to OSM Buildings.
      t.show = true
      t.clippingPolygons = bboxClippingPolygons(aoi.bbox)
    }
    viewer.scene.requestRender()

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let listenerHandle: (() => void) | null = null

    const finish = (reason: string) => {
      if (cancelled) return
      cancelled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
      if (listenerHandle) listenerHandle()
      console.log('[SceneViewer] AOI ready —', reason)
      onAoiBuildingsReady()
    }

    flyToAoi(viewer, aoi.bbox).then(() => {
      if (cancelled) return
      // Wait on whichever tileset is actually rendering buildings — photo
      // takes precedence when present.
      const tileset = photoTilesetRef.current ?? tilesetRef.current
      if (!tileset) {
        finish('no tileset')
        return
      }

      timeoutId = setTimeout(() => finish('timeout'), MAX_LOAD_TIMEOUT_MS)

      const onAllLoaded = () => finish('allTilesLoaded')
      tileset.allTilesLoaded.addEventListener(onAllLoaded)
      listenerHandle = () => tileset.allTilesLoaded.removeEventListener(onAllLoaded)

      requestAnimationFrame(() => {
        if (tileset.tilesLoaded && !cancelled) finish('tilesLoaded synchronous')
      })
    })

    return () => {
      cancelled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
      if (listenerHandle) listenerHandle()
    }
  }, [viewer, aoi, onAoiBuildingsReady])

  return (
    <>
      <BboxPicker enabled={drawMode} onDrawn={onBboxDrawn} onCancel={onCancelDraw} />
      <CoverageLayer />
      <ContestedAirspaceLayer />
      <OoILayer />
      <DroneLayer />
      <AssetLayer />
      <AssetInteraction />
      <ThreatInteraction />
      <SimulationRunner />
      <DeploymentImporter />
    </>
  )
}

export function SceneViewer(props: Props) {
  return (
    <Viewer
      full
      timeline={false}
      animation={false}
      baseLayerPicker={false}
      geocoder={false}
      homeButton={false}
      sceneModePicker={false}
      navigationHelpButton={false}
      fullscreenButton={false}
      infoBox={false}
      selectionIndicator={false}
    >
      <SceneSetup {...props} />
    </Viewer>
  )
}
