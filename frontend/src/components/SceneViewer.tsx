import { useEffect } from 'react'
import { Viewer, useCesium } from 'resium'
import { Cartesian3, Math as CesiumMath, Terrain } from 'cesium'

const SAN_FRANCISCO = {
  longitude: -122.4194,
  latitude: 37.7749,
  height: 3500,
  heading: 30,
  pitch: -30,
}

function CameraInit() {
  const { viewer } = useCesium()

  useEffect(() => {
    if (!viewer) {
      console.warn('[SpectralEye] CameraInit mounted without viewer')
      return
    }

    viewer.scene.setTerrain(Terrain.fromWorldTerrain())
    viewer.scene.globe.depthTestAgainstTerrain = true

    viewer.camera.cancelFlight()
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(
        SAN_FRANCISCO.longitude,
        SAN_FRANCISCO.latitude,
        SAN_FRANCISCO.height,
      ),
      orientation: {
        heading: CesiumMath.toRadians(SAN_FRANCISCO.heading),
        pitch: CesiumMath.toRadians(SAN_FRANCISCO.pitch),
        roll: 0,
      },
    })

    console.log('[SpectralEye] Camera positioned over SF', {
      cameraHeight: viewer.camera.positionCartographic.height,
      pitchDeg: CesiumMath.toDegrees(viewer.camera.pitch),
      headingDeg: CesiumMath.toDegrees(viewer.camera.heading),
    })
  }, [viewer])

  return null
}

export function SceneViewer() {
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
    >
      <CameraInit />
    </Viewer>
  )
}
