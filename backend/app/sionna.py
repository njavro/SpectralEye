"""Sionna RT coverage service contract.

The C2 asks "what does this asset's RF coverage look like in 3D?" and gets
back a path-loss field on a 3D voxel grid. Two implementations behind the
SionnaSource Protocol:

  * MockSionnaSource — closed-form free-space + crude shadowing. Sub-second.
    Used for v0.1 development so the frontend rendering pipeline can be built
    and validated end-to-end before the real Sionna deployment is up.

  * RemoteSionnaSource (Phase 4 C3) — HTTP client to a Colab notebook running
    actual Sionna RT against a Mitsuba scene built from OSM data for the AOI.

Frontend always calls /coverage/sionna and gets the same response shape;
swapping implementations is a one-line change at the binding site.

Grid encoding: path-loss values are float32, packed in row-major order
(x = lon, y = lat, z = altitude). Index of voxel (i, j, k) = i*ny*nz + j*nz + k.
The whole array is base64-encoded so the JSON response stays compact for
~800k-voxel grids (~3 MB raw → ~4 MB base64).
"""

from __future__ import annotations

import base64
import math
import os
from datetime import datetime, timezone
from typing import Literal, Protocol

import httpx
import numpy as np
from fastapi import HTTPException
from pydantic import BaseModel, Field

from app.deployment import Bbox

AssetTypeLiteral = Literal["jammer", "sensor", "relay"]
AntennaPatternLiteral = Literal["omni"]
SourceLiteral = Literal["mock", "sionna_remote"]


class AssetParams(BaseModel):
    type: AssetTypeLiteral
    longitude: float
    latitude: float
    height: float = Field(..., description="Meters above WGS84 ellipsoid (asset base)")
    frequency_mhz: float = Field(..., gt=0)
    erp_dbm: float
    antenna_pattern: AntennaPatternLiteral = "omni"


class GridSpec(BaseModel):
    bbox: Bbox = Field(..., description="Horizontal extent of the voxel grid (matches AOI)")
    voxel_size_m: float = Field(25.0, gt=0)
    height_min_m: float = Field(0.0, description="Lower vertical bound, meters above ground")
    height_max_m: float = Field(500.0, gt=0)


class CoverageRequest(BaseModel):
    asset: AssetParams
    grid_spec: GridSpec


class CoverageGrid(BaseModel):
    """3D path-loss field. values_b64 decodes to a float32 array of length nx*ny*nz."""

    values_b64: str
    nx: int
    ny: int
    nz: int
    bbox: Bbox
    height_min_m: float
    height_max_m: float
    voxel_size_m: float
    units: Literal["dBm"] = "dBm"
    source: SourceLiteral
    computed_at: datetime
    asset_id: str | None = None  # echoed for client-side correlation


class SionnaSource(Protocol):
    async def compute(self, req: CoverageRequest) -> CoverageGrid: ...


# ---------------------------------------------------------------------------
# Mock implementation
# ---------------------------------------------------------------------------

# Reference effective ERP for sensors / passive devices when computing a
# "would-this-emitter-be-detected" coverage volume.
SENSOR_REFERENCE_ERP_DBM = 30.0


def _free_space_loss_db(distance_m: np.ndarray, freq_mhz: float) -> np.ndarray:
    """Friis free-space path loss in dB. distance_m is a numpy array."""
    # Avoid log10(0) at the asset's own voxel.
    d = np.maximum(distance_m, 1.0)
    return 20.0 * np.log10(d) + 20.0 * np.log10(freq_mhz) - 27.55


# Pure free-space falloff produces unrealistically large coverage volumes
# (a 50 dBm jammer "reaches" 10+ km, which dwarfs any reasonable AOI). We
# add a flat urban-loss offset so the mock's coverage volumes fit inside
# typical AOIs and the operator actually sees something.
MOCK_URBAN_LOSS_DB = 20.0


class MockSionnaSource:
    """Plausible-looking coverage with no actual ray tracing.

    Computes free-space path loss from the asset to each voxel center and
    returns received power in dBm. No multipath, no diffraction, no building
    shadows — just an isotropic falloff field. Good enough to validate the
    frontend rendering pipeline and the overall workflow before C3.
    """

    async def compute(self, req: CoverageRequest) -> CoverageGrid:
        asset = req.asset
        spec = req.grid_spec

        # Build voxel center coordinates.
        # Lon/lat span of the bbox, sampled at voxel_size_m converted to degrees
        # at the bbox center latitude.
        center_lat = (spec.bbox.south + spec.bbox.north) / 2
        deg_per_m_lat = 1.0 / 111_320.0
        deg_per_m_lon = 1.0 / (111_320.0 * math.cos(math.radians(center_lat)))

        lon_step = spec.voxel_size_m * deg_per_m_lon
        lat_step = spec.voxel_size_m * deg_per_m_lat

        nx = max(1, int(math.ceil((spec.bbox.east - spec.bbox.west) / lon_step)))
        ny = max(1, int(math.ceil((spec.bbox.north - spec.bbox.south) / lat_step)))
        nz = max(1, int(math.ceil((spec.height_max_m - spec.height_min_m) / spec.voxel_size_m)))

        lons = spec.bbox.west + (np.arange(nx) + 0.5) * lon_step
        lats = spec.bbox.south + (np.arange(ny) + 0.5) * lat_step
        zs = spec.height_min_m + (np.arange(nz) + 0.5) * spec.voxel_size_m

        # Distances from asset to each voxel, in meters.
        # 3D meshgrid would be (nx, ny, nz). Indexing 'ij' keeps natural order.
        LONS, LATS, ZS = np.meshgrid(lons, lats, zs, indexing="ij")
        dx_m = (LONS - asset.longitude) / deg_per_m_lon
        dy_m = (LATS - asset.latitude) / deg_per_m_lat
        dz_m = ZS - asset.height
        dist_m = np.sqrt(dx_m * dx_m + dy_m * dy_m + dz_m * dz_m)

        # Effective transmit power: real ERP for transmitters; reference for sensors
        # (so the volume represents "where could a typical drone emitter be heard").
        erp = asset.erp_dbm if asset.type != "sensor" else SENSOR_REFERENCE_ERP_DBM
        rx_dbm = erp - _free_space_loss_db(dist_m, asset.frequency_mhz) - MOCK_URBAN_LOSS_DB

        flat = rx_dbm.astype(np.float32, copy=False).ravel(order="C")
        encoded = base64.b64encode(flat.tobytes()).decode("ascii")

        return CoverageGrid(
            values_b64=encoded,
            nx=nx,
            ny=ny,
            nz=nz,
            bbox=spec.bbox,
            height_min_m=spec.height_min_m,
            height_max_m=spec.height_min_m + nz * spec.voxel_size_m,
            voxel_size_m=spec.voxel_size_m,
            source="mock",
            computed_at=datetime.now(timezone.utc),
        )


# ---------------------------------------------------------------------------
# Remote Sionna implementation
# ---------------------------------------------------------------------------


class RemoteSionnaSource:
    """HTTP client to a Colab notebook running real Sionna RT.

    Same request/response shape as MockSionnaSource. Selected automatically
    when SIONNA_REMOTE_URL is set in the backend's environment."""

    def __init__(self, base_url: str, timeout_s: float = 600.0):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s

    async def compute(self, req: CoverageRequest) -> CoverageGrid:
        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            r = await client.post(
                f"{self.base_url}/coverage/sionna",
                json=req.model_dump(mode="json"),
            )
        if r.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Remote Sionna server returned {r.status_code}: {r.text[:200]}",
            )
        return CoverageGrid(**r.json())


# ---------------------------------------------------------------------------
# Source binding — picks remote if SIONNA_REMOTE_URL is set, else mock.
# ---------------------------------------------------------------------------


def _build_default_source() -> SionnaSource:
    url = os.environ.get("SIONNA_REMOTE_URL", "").strip()
    if url:
        print(f"[Sionna] using RemoteSionnaSource at {url}")
        return RemoteSionnaSource(url)
    print("[Sionna] using MockSionnaSource (set SIONNA_REMOTE_URL to enable real Sionna)")
    return MockSionnaSource()


_default_source: SionnaSource = _build_default_source()


def get_sionna_source() -> SionnaSource:
    return _default_source
