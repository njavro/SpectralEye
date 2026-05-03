"""Local stand-in for the Colab Sionna notebook.

Implements exactly the wire contract the real notebook exposes (see
build_notebook.py / API_CODE), but produces synthetic coverage analytically
so we can validate the backend's RemoteSionnaSource end-to-end without
needing a GPU or a cloudflared tunnel.

Use it to verify:
  * Backend's RemoteSionnaSource POSTs the right request shape.
  * Backend deserialises the response correctly (base64, grid dims, units).
  * The frontend renders the resulting volume.
  * CORS / error paths behave when SIONNA_REMOTE_URL points to "real" Sionna.

Run:
    python3 colab/fake_remote_dev.py
    # then in backend/.env: SIONNA_REMOTE_URL=http://127.0.0.1:8765
    # restart backend, hit "Show EMS" in the UI

The math here is the same Friis-plus-urban-loss as MockSionnaSource — the
intent is to prove the wire works, not to be a second mock implementation.
"""

from __future__ import annotations

import base64
import math
from datetime import datetime, timezone
from typing import Literal

import numpy as np
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel, Field

PORT = 8765
URBAN_LOSS_DB = 20.0
SENSOR_REFERENCE_ERP_DBM = 30.0


class _Bbox(BaseModel):
    west: float
    south: float
    east: float
    north: float


class _AssetParams(BaseModel):
    type: Literal["jammer", "sensor", "relay"]
    longitude: float
    latitude: float
    height: float
    frequency_mhz: float = Field(..., gt=0)
    erp_dbm: float
    antenna_pattern: str = "omni"


class _GridSpec(BaseModel):
    bbox: _Bbox
    voxel_size_m: float = 25.0
    height_min_m: float = 0.0
    height_max_m: float = 500.0


class _CoverageRequest(BaseModel):
    asset: _AssetParams
    grid_spec: _GridSpec


app = FastAPI(title="Fake Sionna Remote (dev)")


@app.get("/health")
def health() -> dict[str, object]:
    return {"status": "ok", "source": "sionna_remote_fake", "gpu": False}


def _free_space_loss_db(dist_m: np.ndarray, freq_mhz: float) -> np.ndarray:
    d = np.maximum(dist_m, 1.0)
    return 20.0 * np.log10(d) + 20.0 * np.log10(freq_mhz) - 27.55


@app.post("/coverage/sionna")
def coverage(req: _CoverageRequest) -> dict[str, object]:
    a = req.asset
    s = req.grid_spec
    bbox = s.bbox

    center_lat = (bbox.south + bbox.north) / 2
    deg_per_m_lat = 1.0 / 111_320.0
    deg_per_m_lon = 1.0 / (111_320.0 * math.cos(math.radians(center_lat)))
    lon_step = s.voxel_size_m * deg_per_m_lon
    lat_step = s.voxel_size_m * deg_per_m_lat

    nx = max(1, int(math.ceil((bbox.east - bbox.west) / lon_step)))
    ny = max(1, int(math.ceil((bbox.north - bbox.south) / lat_step)))
    nz = max(1, int(math.ceil((s.height_max_m - s.height_min_m) / s.voxel_size_m)))

    lons = bbox.west + (np.arange(nx) + 0.5) * lon_step
    lats = bbox.south + (np.arange(ny) + 0.5) * lat_step
    zs = s.height_min_m + (np.arange(nz) + 0.5) * s.voxel_size_m

    LONS, LATS, ZS = np.meshgrid(lons, lats, zs, indexing="ij")
    dx_m = (LONS - a.longitude) / deg_per_m_lon
    dy_m = (LATS - a.latitude) / deg_per_m_lat
    dz_m = ZS - a.height
    dist_m = np.sqrt(dx_m * dx_m + dy_m * dy_m + dz_m * dz_m)

    erp = a.erp_dbm if a.type != "sensor" else SENSOR_REFERENCE_ERP_DBM
    rx_dbm = erp - _free_space_loss_db(dist_m, a.frequency_mhz) - URBAN_LOSS_DB

    flat = rx_dbm.astype(np.float32, copy=False).ravel(order="C")
    encoded = base64.b64encode(flat.tobytes()).decode("ascii")

    print(
        f"[fake-remote] {a.type} f={a.frequency_mhz}MHz erp={a.erp_dbm}dBm "
        f"→ {nx}x{ny}x{nz} grid, range {float(rx_dbm.min()):.1f}→{float(rx_dbm.max()):.1f} dBm"
    )

    return {
        "values_b64": encoded,
        "nx": nx,
        "ny": ny,
        "nz": nz,
        "bbox": {"west": bbox.west, "south": bbox.south, "east": bbox.east, "north": bbox.north},
        "height_min_m": s.height_min_m,
        "height_max_m": s.height_min_m + nz * s.voxel_size_m,
        "voxel_size_m": s.voxel_size_m,
        "units": "dBm",
        "source": "sionna_remote",
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }


if __name__ == "__main__":
    print(f"[fake-remote] listening on http://127.0.0.1:{PORT}")
    print(f"[fake-remote] set SIONNA_REMOTE_URL=http://127.0.0.1:{PORT} in backend/.env")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
