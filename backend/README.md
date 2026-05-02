# SpectralEye Backend

FastAPI service for asset/scene state, the empirical propagation model, and the Sionna RT client.

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Run

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Health check: <http://127.0.0.1:8000/health>
API docs: <http://127.0.0.1:8000/docs>
