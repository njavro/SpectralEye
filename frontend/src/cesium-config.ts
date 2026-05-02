import { Camera, Ion, Rectangle } from 'cesium'

const token = import.meta.env.VITE_CESIUM_ION_TOKEN

if (!token) {
  console.warn(
    '[SpectralEye] VITE_CESIUM_ION_TOKEN is not set. Copy frontend/.env.example to frontend/.env.local and add your Cesium ion token.',
  )
}

Ion.defaultAccessToken = token ?? ''

// Default startup view: San Francisco bounding box (overrides Cesium's global home view).
// useEffect-based setView fights Cesium's own initial camera; setting this before any Viewer
// mounts is the only reliable way to land on a specific area on first render.
Camera.DEFAULT_VIEW_RECTANGLE = Rectangle.fromDegrees(-122.55, 37.7, -122.35, 37.84)
