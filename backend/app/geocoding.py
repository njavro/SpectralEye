"""Nominatim reverse geocoding for AOI labeling.

Nominatim is OpenStreetMap's free geocoder. Public usage policy requires:
  - a unique User-Agent identifying the application
  - max 1 req/sec
  - attribution in any UI surfacing the results

https://operations.osmfoundation.org/policies/nominatim/
"""

from typing import Any

import httpx
from fastapi import HTTPException

NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
USER_AGENT = "SpectralEye/0.1 (https://github.com/njavro/SpectralEye; EW C2 demo)"
DEFAULT_TIMEOUT = 8.0


async def reverse(lat: float, lon: float) -> dict[str, Any] | None:
    params = {
        "lat": str(lat),
        "lon": str(lon),
        "format": "jsonv2",
        "zoom": "14",
        "addressdetails": "1",
    }
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        r = await client.get(
            f"{NOMINATIM_BASE}/reverse",
            params=params,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en"},
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Nominatim returned {r.status_code}")
    raw = r.json()
    if "error" in raw:
        return None
    return {
        "display_name": raw.get("display_name", ""),
        "lat": float(raw["lat"]),
        "lon": float(raw["lon"]),
        "type": raw.get("type"),
        "category": raw.get("category"),
        "address": raw.get("address", {}),
    }
