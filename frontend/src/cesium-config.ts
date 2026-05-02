import { Ion } from 'cesium'

const token = import.meta.env.VITE_CESIUM_ION_TOKEN

if (!token) {
  console.warn(
    '[SpectralEye] VITE_CESIUM_ION_TOKEN is not set. Copy frontend/.env.example to frontend/.env.local and add your Cesium ion token.',
  )
}

Ion.defaultAccessToken = token ?? ''
