import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Side-effect import: registers the <model-viewer> custom element used in
// the asset palette to render mini 3D previews of each asset type's GLB.
import '@google/model-viewer'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
