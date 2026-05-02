import './cesium-config'
import { SceneViewer } from './components/SceneViewer'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      <header className="top-bar">
        <span className="brand">SpectralEye</span>
        <span className="subtitle">EW C2 — v0.1</span>
      </header>
      <main className="scene-container">
        <SceneViewer />
      </main>
    </div>
  )
}

export default App
