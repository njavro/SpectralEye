# SpectralEye

**Electronic Warfare Command & Control with integrated, GPU-ray-traced RF propagation modelling.**

A web-based C2 platform for EW operators to plan, manage, and stress-test their RF posture inside a real 3D urban scene. SpectralEye does two things at once that EW tools usually treat as separate problems:

1. **Plugs into the live deployment** — pulls self-reports from the assets currently in the field (jammers, RF sensors, comms relays) and surfaces them on the map with their real positions, frequencies, and ERPs.
2. **Lets the operator place *simulated* assets** on top of the live picture — to ask "what if I add another jammer here?", "would my relay still cover the south end if a hostile jammer dropped here?", or "does my whole posture survive a 100 W area-denial weapon at this rooftop?" — all without touching deployed hardware.

The same map also accepts **simulated hostile drones** with planned waypoints, frequencies, and tolerances. The operator runs the simulation; SpectralEye computes the RF interaction between the deployed posture, the hypothetical additions, and the threats — using **NVIDIA Sionna RT** for ground-truth GPU ray tracing — and shows in real time which drones break through, which get jammed, and which protected points get penetrated.

> **In short:** SpectralEye is a digital twin of your EW posture *and* a sandbox for adversarial drone scenarios. You can pen-test your own deployment before the threat shows up.

---

## Table of contents

- [What it does](#what-it-does)
- [Key capabilities](#key-capabilities)
- [Architecture](#architecture)
- [Why Sionna RT](#why-sionna-rt)
- [Setup](#setup)
- [The operator workflow](#the-operator-workflow)
- [Pen-testing your deployment](#pen-testing-your-deployment)
- [Repo layout](#repo-layout)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## What it does

SpectralEye is a single-pane-of-glass tool for an EW commander. The operator marks an Area of Operation on a 3D globe, and inside that AOI they can:

- **Ingest the current friendly deployment** (jammers, RF sensors, comms relays) from a self-reporting feed and see where each asset is, what frequency it covers, and what RF footprint it produces.
- **Place additional assets** that are *not* really deployed — purely simulated overlays for "what if" planning. These behave identically to the real ones in the model: they propagate RF, contribute to coverage gaps and overlaps, and influence jamming math. They just don't exist in the field.
- **Plan hostile drone trajectories** by placing waypoints on the map. Every drone has a configurable frequency, speed, and SJR tolerance.
- **Place Strategic Points of Interest (SPoI)** — assets to defend — with a ground-anchored safety dome. Drones penetrating a dome trigger a critical-warning alarm.
- **Run the simulation**: drones fly at a constant 50 m AGL along their planned routes, and at every frame the system asks "is this drone in any co-channel jammer's effective zone?" If yes, the drone freezes in place, a red link is drawn from the offending jammer to the kill point, and the live SJR readout next to the drone tells the operator exactly why.

Every RF computation that decides "is this drone jammed?" comes from the same Sionna RT grid that draws the visible Contested Airspace volume, so what the operator sees on screen and what the simulation does to the drone are the **same answer**, computed once.

---

## Key capabilities

### Live + hypothetical, in one picture

The system makes no visual distinction at the rendering layer between "this jammer is really deployed in Bay Street" and "this jammer is what I'm thinking of buying next quarter." Both render as 3D assets, both produce the same Sionna-traced coverage volumes, both contribute to jamming math. The only thing that changes is your intent — the operator can flip a simulated asset to "deployed" status when they decide to actually field it, with a single click.

### Threat-side simulation

Drones, SPoI, and intrusion alarms form a parallel "what could happen to me" track:

- **Drone planning** — click to drop a start point, click to drop waypoints. Drone altitude is auto-clamped to 50 m above the local terrain at every waypoint, so paths stay at a uniform AGL across hilly territory.
- **SJR jamming** — at every frame, every drone samples the strongest co-channel jammer signal in its airspace column. If `SJR < drone.sjrThresholdDb` (default 10 dB), the drone is **frozen in place**, marker tints orange, and a dashed red line is drawn from the jammer to the kill point. The drone's in-scene label shows live SJR in dB so the operator can read jammer strength straight off the map.
- **Intrusion detection** — drone enters an SPoI safety dome → dome turns red, drone marker turns red, and a hazard-striped pulsing banner reads **"CRITICAL WARNING — UNKNOWN ENTITY PENETRATED THE PERIMETER"** with the drone callsign and SPoI ID. The banner latches; it stays visible until the operator clicks **Situation Mitigated**, even after the drone exits the dome or finishes its run.

### Contested Airspace visualisation

A toggleable overlay paints every voxel in the AOI where any deployed jammer's signal exceeds the drone-link defeat threshold. Rendered as filled translucent magenta cubes (not a hollow shell — a hollow shell visually disappeared when the camera was inside the bubble near the jammer), so the operator can read at a glance "where in this AOI would my drone get jammed?" The volume is the literal output of the same Sionna grid the simulation uses, so visual and behaviour are guaranteed consistent.

### Per-asset effective coverage

When a co-channel jammer is present, every relay/sensor switches from its normal nested-shell rendering to a **two-shell layout**: a faded outer "ghost" of the volume the asset *would* cover without jamming, plus a vivid inner volume of what *survives* the jammer's interference. The visible gap between them is the volume the jammer killed. The asset's detail panel also shows a **% retained** retention bar (green ≥75%, orange 40-75%, red <40%) so the operator can quantify the impact.

### Drag-and-drop pen testing

The combined "live + hypothetical + threat" model means an operator can test arbitrary scenarios without ever touching a real radio:

- *"What if a hostile DJI swarm shows up tomorrow, can my current posture stop it?"* — plan the drones, run the sim, see which ones get through.
- *"My boss wants to know if we still need RLY-02 on the south hill."* — delete it from the simulated picture, watch the relay coverage volume contract; if it doesn't matter operationally, retire the hardware.
- *"A counter-jammer is coming online next week — where should it go to maximise drone defeat against the planned threat path?"* — drop a hypothetical jammer, drag it around, watch the contested airspace and per-drone SJR update live.

This is **pen testing your own EW posture against simulated adversaries**, in 3D, with real ray-traced physics — before the adversary arrives.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Browser                                 │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ React + Vite + Cesium (3D globe, terrain, OSM Buildings,   │  │
│ │ optional Google Photorealistic 3D Tiles, glTF asset models)│  │
│ │                                                            │  │
│ │ State: Zustand store (assets, drones, SPoI, sim runtime,   │  │
│ │ coverage grids cache, sim status)                          │  │
│ │                                                            │  │
│ │ Layers: AssetLayer · DroneLayer · OoILayer · CoverageLayer │  │
│ │         ContestedAirspaceLayer · SimulationRunner          │  │
│ └────────────────────────────────────────────────────────────┘  │
└─────────────────────┬─────────────────────┬─────────────────────┘
                      │ /coverage/sionna     │ /deployment/current
                      │ /water/in-bbox       │ /reverse
                      ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Backend (FastAPI / Python)                      │
│  · MockSionnaSource (CPU, free-space + urban-loss)               │
│  · RemoteSionnaSource ─────────► HTTPS ───────────┐              │
│  · SimulatedDeploymentSource (jammer + sensor +   │              │
│    relay triad)                                   │              │
│  · OSM water polygons (for placement validation)  │              │
└───────────────────────────────────────────────────┼──────────────┘
                                                    │
                                  cloudflared tunnel│ (free tier)
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│        NVIDIA Colab notebook (T4 GPU, free tier)                 │
│  · FastAPI server on localhost                                   │
│  · OSM Overpass query → building footprints (cached per AOI)     │
│  · Mitsuba 3 scene assembly (PLY meshes from earcut'd polygons)  │
│  · Sionna RT RadioMapSolver per altitude slice                   │
│  · Returns base64-encoded float32 voxel grid                     │
└─────────────────────────────────────────────────────────────────┘
```

The frontend is a single Cesium scene with React layers on top. It talks to a local FastAPI backend, which in turn relays the heavy lifting (Sionna RT) to a Colab notebook over a cloudflared tunnel. The wire contract between backend and Colab is a single POST `/coverage/sionna` returning a base64-encoded float32 voxel grid. Both sides are fully decoupled from each other — the same backend can be pointed at a local mock (`MockSionnaSource`, free-space + urban loss, sub-second) for development, or at a Colab tunnel (`RemoteSionnaSource`, real ray tracing, ~10 s/request) for fidelity.

### Why a remote GPU?

Sionna RT requires CUDA. Running it on the operator's machine would mean shipping every customer a GPU. Instead we use the architecture that ML researchers use: **Google Colab provides free T4 GPUs**, **cloudflared provides free public HTTPS tunnels**. A short notebook hosts a FastAPI server on the Colab side, the tunnel exposes it, and the local backend calls into it. Total marginal cost per request: $0.

For production, this remote pattern trivially swaps to a paid GPU (any cloud provider, an on-prem rig, an AWS Inferentia instance) without changing a line of frontend or backend code. The wire contract stays the same.

### Photorealistic terrain (optional)

When `VITE_GOOGLE_MAP_TILES_API_KEY` is set in the frontend `.env`, SpectralEye loads **Google's Photorealistic 3D Tiles** inside the AOI bounding box, replacing the flat-coloured OSM Buildings that ship by default. RF propagation is **never** touched by this — Sionna only sees the OSM polygons fetched server-side. The photorealistic mesh is purely cosmetic, but it transforms the demo: instead of stylised grey blocks, the operator is staring at textured photorealistic San Francisco / Manhattan / wherever they marked the AOI.

---

## Why Sionna RT

Sionna RT is NVIDIA's open-source, **differentiable, GPU-accelerated electromagnetic ray tracer**. It models how RF energy actually propagates through a 3D scene — every reflection off a building, every diffraction over a rooftop, every multipath echo down an urban canyon. Inputs are a Mitsuba 3 scene (geometry + material properties) and a transmitter (frequency, ERP, antenna pattern); outputs are per-voxel received power, channel impulse responses, angle-of-arrival distributions, and so on.

### Why this matters for EW

Most "RF coverage" tools you'll see in EW software use one of:

- **Free-space path loss (Friis)** — pretend every signal travels in vacuum. Works in space, lies in cities.
- **Cost-231 / Hata empirical models** — fit a curve to drive-test data from 1990s GSM trials. Adds an "urban loss" fudge term. Doesn't know what an actual building looks like.
- **Ray tracing in 2.5D** — models a top-down city as flat polygons with a single height per polygon. Ignores rooftops, balconies, antennas-on-towers.

These are fine for back-of-envelope estimates. They are **wrong** for things like:

- A jammer on a 30-story rooftop *should* dominate the surrounding airspace via clear line-of-sight to drones overhead — but its signal is strongly attenuated for a drone in the street canyon next door, behind a taller building. A Friis model says the jammer reaches both equally.
- A relay's coverage at an intersection is enhanced by multipath bouncing off the four buildings on the corner. An empirical model gives a single distance-based number.
- A drone pilot can sometimes "duck behind" a building to break a jamming link. A 2.5D model can't predict where those shadows are.

**Sionna RT models all of this correctly.** The contested-airspace volumes you see in SpectralEye literally have building shadows carved out of them. Drone paths through urban canyons survive jamming that would have killed them on flat ground. The simulation is not a simplification of reality — it is reality, ray-traced.

### Performance

A typical 1.5 km AOI with ~200 buildings:

- OSM Overpass fetch: ~2-5 s (cached per-AOI after the first request)
- Mitsuba 3 scene build: ~1-3 s
- Sionna RadioMapSolver, 4 altitude slices, 2M samples per TX: ~6-12 s on a Colab T4

So expect ~10-20 s for the first asset's coverage in a fresh AOI, and ~6-10 s per additional asset. The notebook's `_COVERAGE_LOCK` serialises requests so the GPU isn't contended; the `_SCENE_CACHE` ensures the second-and-later asset's request skips the OSM round trip entirely.

---

## Setup

### 1. Frontend

```bash
cd frontend
cp .env.example .env
# edit .env — see env vars below
npm install
npm run dev   # http://127.0.0.1:5173
```

Required env vars in `frontend/.env`:

| Variable | Required | Notes |
|---|---|---|
| `VITE_CESIUM_ION_TOKEN` | yes | Free token from <https://cesium.com/ion> |
| `VITE_API_BASE_URL` | yes | Usually `http://127.0.0.1:8000` |
| `VITE_GOOGLE_MAP_TILES_API_KEY` | optional | Enables photorealistic 3D Tiles inside the AOI; without it falls back to OSM Buildings |

For the Google key: Google Cloud Console → enable **Map Tiles API** → Credentials → create key → restrict to `localhost:*` for dev. Free tier is 200k tile requests/month.

### 2. Backend

```bash
cd backend
python3.14 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Or use the convenience script (recommended — handles "kill anything on :8000" + path discovery):

```bash
./restart-backend.sh           # background, logs to /tmp/spectraleye-backend.log
./restart-backend.sh --fg      # foreground (Ctrl-C to stop)
```

Optional env vars in `backend/.env`:

| Variable | Required | Notes |
|---|---|---|
| `SIONNA_REMOTE_URL` | optional | URL of your Sionna Colab tunnel. If unset, falls back to MockSionnaSource (analytical free-space + urban loss; no GPU needed). |

### 3. Sionna RT Colab notebook (for real ray-traced coverage)

```text
1. Open colab/spectraleye_sionna.ipynb in Google Colab
2. Runtime → Change runtime type → T4 GPU
3. Run the install cell, wait for "INSTALL COMPLETE — MANUAL RESTART REQUIRED"
4. Runtime → Restart session
5. Run all remaining cells in order
6. Step 7 prints a public URL like https://<random>.trycloudflare.com
7. Paste that URL into backend/.env as SIONNA_REMOTE_URL=...
8. Restart the backend (./restart-backend.sh)
```

Smoke-test the wiring without touching the UI:

```bash
curl -s -X POST http://127.0.0.1:8000/coverage/sionna -H "Content-Type: application/json" -d '{
  "asset":{"type":"jammer","longitude":-122.42,"latitude":37.77,"height":50,"frequency_mhz":2400,"erp_dbm":40,"antenna_pattern":"omni"},
  "grid_spec":{"bbox":{"west":-122.43,"south":37.765,"east":-122.41,"north":37.78},"voxel_size_m":25,"height_min_m":0,"height_max_m":100}
}' | head -c 200
```

Successful response begins with `{"values_b64":"...` and `"source":"sionna_remote"`.

### 4. Local fake remote (no Colab, for development)

When you don't want to spin up Colab — `colab/fake_remote_dev.py` runs the same wire contract locally with analytical math:

```bash
python3 colab/fake_remote_dev.py     # listens on http://127.0.0.1:8765
# Then in backend/.env: SIONNA_REMOTE_URL=http://127.0.0.1:8765
# Restart backend.
```

Less realistic than Sionna (no building shadowing, no multipath), but rock-solid for verifying the backend↔remote pipeline and the frontend rendering path.

---

## The operator workflow

A typical session:

1. **Mark the AOI** — top-bar button → click-drag a bounding box on the globe. Buildings, terrain, water polygons all load for that area.
2. **Pull the live deployment** — left-side palette → **Report Current Deployment**. Three-stage loading sequence (link establishment → reports incoming → terrain cross-reference) populates the AOI with the currently-deployed triad: 1 jammer (JAM-01), 1 sensor (SEN-01), 1 relay (RLY-01).
3. **Add hypothetical assets** — left-side palette → click a model preview → click on the map to drop. Identical behaviour to deployed assets, just visually marked as hypothetical. Use this to test "what if" scenarios without affecting the real picture.
4. **Show EMS** — palette → **Show EMS**. Each asset's 3D coverage volume renders (red = jammer, blue = sensor, yellow = relay). When jammers are present, sensor/relay volumes auto-switch to ghost-and-effective rendering so you see the impact.
5. **Show Contested Airspace** — Situation Modeling panel → toggle on. Magenta voxel cloud paints every cell in the AOI where a default-tuned drone would be jammed. Auto-loads any jammer's coverage grid not already cached.
6. **Place SPoI to defend** — palette → **Place Strategic Point of Interest** → click. Adjustable safety perimeter in the detail panel.
7. **Plan threat drones** — Situation Modeling panel → **Plan Drone Threat** → first click sets the spawn, subsequent clicks add waypoints. Esc to finish. Each drone gets a callsign, configurable speed, frequency, and SJR threshold.
8. **Run the simulation** — Situation Modeling panel → **Run**. Drones animate along their paths at uniform 50 m AGL. Live SJR readout next to each drone shows its current jamming margin in dB. Drones flying through contested airspace freeze in place with a red jammer→drone link line. Drones penetrating an SPoI dome trigger the critical-warning banner.
9. **React to alerts** — banner stays visible until you click **Situation Mitigated**, so brief fly-through breaches can't be missed.

---

## Pen-testing your deployment

The hypothetical-asset / threat-drone combination makes SpectralEye a pen-testing rig for your own posture. A few patterns:

### Find coverage gaps

1. Pull the live deployment.
2. Plan a drone path through the area you suspect is uncovered.
3. Run the sim. If the drone reaches its target without ever getting jammed, you have a gap exactly where the trajectory passes.
4. Drop a hypothetical jammer at the worst point along the trajectory. Re-run.
5. Iterate placement until the drone is reliably defeated.
6. Once you find a placement that works, flip the hypothetical jammer to **deployed** status and procure / field the real asset.

### Quantify a jammer's blast radius

1. Drop a single jammer at a candidate site.
2. Toggle Contested Airspace.
3. The magenta volume IS the area where any default-tuned drone would be defeated. Read the volume's footprint to size the asset's coverage.
4. Tune the asset's ERP up and down in the detail panel; the volume re-renders in real time. Now you have an evidence-based answer to "do I need 10 W or 100 W here?"

### Stress-test against new threats

1. Plan a drone with the threat's actual frequency and SJR threshold (e.g., a frequency-hopping FPV with strong link margin).
2. Run the sim against your deployed posture as-is.
3. If the drone breaks through, you know your existing assets are insufficient against this class of threat — even before the threat shows up in the field.

The whole workflow happens client-side on a laptop. The operator never has to file a range request or schedule live-fire testing.

---

## Repo layout

```
spectraleye/
├── frontend/                     React + Vite + TypeScript
│   ├── public/models/            glTF (.glb) asset models served by Vite
│   └── src/
│       ├── App.tsx               Top-level layout, top bar, overlays
│       ├── store.ts              Zustand store (assets, drones, SPoI, sim)
│       ├── api.ts                Backend HTTP client
│       ├── types.ts              Asset/Drone/Waypoint/SPoI types + constants
│       └── components/
│           ├── SceneViewer.tsx           Cesium viewer + AOI clipping + tilesets
│           ├── AssetPalette.tsx          Left-side: asset placement + EMS toggles
│           ├── AssetLayer.tsx            Renders deployed assets (glTF models)
│           ├── AssetInteraction.tsx      Click-to-place / click-to-select
│           ├── AssetDetailPanel.tsx      Right-side: edit asset, retention badge
│           ├── DroneLayer.tsx            Drone marker + label + jam-link line
│           ├── DroneDetailPanel.tsx      Right-side: edit drone params
│           ├── OoILayer.tsx              SPoI marker + dome
│           ├── OoIDetailPanel.tsx        Right-side: edit SPoI
│           ├── ThreatInteraction.tsx     Click-to-place SPoI / drone waypoints
│           ├── SituationModelingPanel.tsx Right-side: drones, sim controls,
│           │                              contested-airspace toggle
│           ├── CoverageLayer.tsx         Marching-cubes EMS volumes
│           ├── ContestedAirspaceLayer.tsx Voxel-fill jammer-vs-drone overlay
│           ├── coverageMath.ts           Pure jammer-aware coverage math
│           ├── SimulationRunner.tsx      rAF tick: position + intrusion + SJR
│           ├── simulation.ts             Pure path/intrusion/SJR helpers
│           ├── IntrusionAlertOverlay.tsx Pulsing critical-warning banner
│           ├── DeploymentImporter.tsx    Snap reports to land + sample heights
│           └── assetVisuals.ts           glTF URI/scale config per type
├── backend/                      FastAPI + Python 3.14
│   └── app/
│       ├── main.py               Routes + CORS + dependency injection
│       ├── sionna.py             SionnaSource Protocol + Mock + Remote impls
│       ├── deployment.py         SimulatedDeploymentSource (one-of-each triad)
│       ├── water.py              OSM water polygon fetcher
│       └── geocoding.py          Nominatim reverse-geocode
├── colab/
│   ├── build_notebook.py         Source-of-truth Python; generates the .ipynb
│   ├── spectraleye_sionna.ipynb  Generated artifact — upload this to Colab
│   └── fake_remote_dev.py        Local stand-in for the Colab notebook
├── 3d-models/                    Source GLB files (also copied into frontend/public/models/)
├── restart-backend.sh            Convenience: kill :8000 + restart uvicorn
└── docs/                         Specs and design notes
```

---

## Troubleshooting

### "POST /coverage/sionna 502 Bad Gateway" with `530` in the response

Cloudflare's "origin down." Your Colab session has disconnected. Re-open the notebook tab, click **Reconnect**, and re-run from the FastAPI cell onwards. New tunnel URL → paste into `backend/.env` → restart backend.

### "Overpass 429" inside the Colab cell output

OSM Overpass rate-limited the Colab IP. The notebook caches scenes per AOI (`_SCENE_CACHE`) so this should only happen on the first request for a given AOI. If you're hitting it for subsequent requests, your Colab notebook is older than the `_SCENE_CACHE` fix — re-upload the notebook from `colab/spectraleye_sionna.ipynb`.

### Drone gets jammed by a single jammer but not the second

Either the second jammer's coverage grid never made it to the cache (check console for `[CoverageLayer w0] fetching coverage for JAM-XX` and the backend log for `[Sionna] FAIL` lines) or its frequency is outside the ±80 MHz match window vs the drone's frequency (check the asset detail panel for both).

### Photorealistic 3D Tiles not loading

Browser console will say `[SpectralEye] VITE_GOOGLE_MAP_TILES_API_KEY not set — using OSM Buildings only` (env var missing or Vite wasn't restarted) or a 404/403 response from `tile.googleapis.com` (Map Tiles API not enabled on your Google Cloud project, or billing not linked).

### Backend errors with CORS message in the browser

CORS responses bypass when the backend throws a transport-level exception (DNS failure, dead tunnel). Check the actual cause in `tail /tmp/spectraleye-backend.log`. Look for `[Sionna] FAIL` lines.

### Sensor model is the wrong size

The GLB scale is per-type in `frontend/src/components/assetVisuals.ts:MODEL_SCALE`. Edit and HMR will pick it up.

---

## Roadmap

| Phase | Status | Deliverable |
|---|---|---|
| 0 | done | Bootstrap repo, Cesium scene |
| 1 | done | AOI marking + 3D scene loading worldwide |
| 2 | done | Asset model + click-to-place + detail panel |
| 4a | done | Backend Sionna service contract + MockSionnaSource |
| 4b | done | Real Sionna RT on Colab + RemoteSionnaSource |
| 4c | done | Frontend marching-cubes coverage volumes |
| 5  | partial | Visual polish for committed/hypothetical |
| 6a | done | Drone + SPoI entities |
| 6b | done | Drone animation (run/pause/reset) |
| 6c | done | Intrusion detection + critical-warning alarm |
| 6d | done | SJR jamming + freeze + jammer→drone link |
| 6+ | done | Contested Airspace overlay, per-asset effective coverage, glTF asset models, photorealistic 3D Tiles overlay, terrain-following drones, live in-scene SJR HUD |
| 7 | pending | Compare overlay (committed vs hypothetical), aggregate union mesh, summary panel |
| 8 | pending | Spectrum panel (per-asset frequency-occupancy bars + 3D scene linkage) |
| 9 | pending | Acceptance criteria walkthrough + production setup docs |

---

*Built with Cesium, NVIDIA Sionna RT, FastAPI, React, Mitsuba 3, and a lot of OSM data.*
