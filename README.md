# SpectralEye

Electronic Warfare Command and Control with Integrated RF Propagation Modeling.

A web application for an EW operator to manage RF posture in a 3D urban scene. The defining design idea is the **committed vs hypothetical** split:

- **Committed** assets — high-fidelity ray tracing on a remote GPU (NVIDIA Sionna RT), cached, rendered solid.
- **Hypothetical** assets — fast empirical propagation (COST-231) running CPU-side at 10+ Hz during drag, rendered translucent / hatched.

See `docs/SpectralEye_v0.1_Requirements.docx` for the v0.1 specification.

## Repo layout

```
frontend/   React + Vite + TypeScript + Resium (Cesium for React)
backend/    FastAPI + Python (state, empirical model, Sionna client)
docs/       Specs and design notes
```

## Setup

### Frontend

```bash
cd frontend
cp .env.example .env.local   # then paste your Cesium ion token into .env.local
npm install
npm run dev                  # http://127.0.0.1:5173
```

Get a free Cesium ion access token at <https://cesium.com/ion>.

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Health: <http://127.0.0.1:8000/health>
API docs: <http://127.0.0.1:8000/docs>

## Implementation phases

Each phase ends in a runnable demo.

| Phase | Deliverable |
|------:|-------------|
| 0 | Bootstrap repo + empty Cesium scene + FastAPI health endpoint |
| 1 | Location entry screen + worldwide 3D scene loading |
| 2 | Asset placement, edit, move, delete |
| 3 | Empirical propagation + hypothetical coverage volumes (live drag) |
| 4a | Backend + mock Sionna service behind a stable contract |
| 4b | Real Sionna RT on Colab Pro, OSM → Mitsuba scene pipeline |
| 5 | Commit/promote workflow with state machine |
| 6 | Threat scenarios + coverage assessment |
| 7 | Compare overlay + aggregate views |
| 8 | Spectrum panel (frequency occupancy) |
| 9 | Acceptance criteria walkthrough + docs |
