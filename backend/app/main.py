from typing import Any

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from app import geocoding
from app.deployment import Bbox, DeploymentReport, get_deployment_source
from app.sionna import CoverageGrid, CoverageRequest, get_sionna_source
from app.water import WaterPolygons, fetch_water_polygons

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


@app.post("/water/in-bbox")
async def water_in_bbox(bbox: Bbox) -> WaterPolygons:
    """Returns OSM water polygons (oceans, rivers, lakes) intersecting the bbox.

    Used by the frontend to reject land-only EW assets dropped on water and to
    filter water-positioned reports out of self-reported deployments."""
    return await fetch_water_polygons(bbox)


@app.post("/coverage/sionna")
async def coverage_sionna(req: CoverageRequest) -> CoverageGrid:
    """Compute an asset's RF coverage as a 3D path-loss voxel grid.

    Currently bound to MockSionnaSource — see backend/app/sionna.py for the
    swap point that brings up real Sionna RT in Phase 4 C3."""
    source = get_sionna_source()
    return await source.compute(req)
