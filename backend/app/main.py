from typing import Any

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from app import geocoding
from app.deployment import Bbox, DeploymentReport, get_deployment_source

app = FastAPI(title="SpectralEye Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "spectraleye-backend"}


@app.get("/reverse")
async def reverse_geocode(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
) -> dict[str, Any] | None:
    """Reverse-geocode a point to a friendly place name (used to label the AOI center)."""
    return await geocoding.reverse(lat, lon)


@app.post("/deployment/current")
async def deployment_current(bbox: Bbox) -> DeploymentReport:
    """Returns the C2's current view of deployed EW assets within the bbox.

    Backed by SimulatedDeploymentSource for v0.1; swap the implementation when
    real hardware aggregation is available."""
    source = get_deployment_source()
    return await source.fetch_current_deployment(bbox)
