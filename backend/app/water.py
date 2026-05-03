"""Water-body lookup via OSM Overpass.

Cesium terrain returns ellipsoidal heights, which makes a height-based
water/land heuristic fail in regions with significant geoid undulation
(e.g. SF coastal area is ~32 m below the ellipsoid even on dry land).
The reliable approach is to fetch OSM water polygons and do point-in-polygon.

Big water bodies (SF Bay, named lakes/seas) are typically OSM multipolygon
RELATIONS whose outer ring is split across several way fragments. Doing this
assembly by hand is error-prone, so we lean on osm2geojson which produces
proper closed polygons (with holes preserved as inner rings — we discard
them since "is in water" doesn't care about land-inside-water islands).
"""

from __future__ import annotations

from typing import Any

import httpx
import osm2geojson
from fastapi import HTTPException
from pydantic import BaseModel

from app.deployment import Bbox

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT_S = 30.0


class WaterPolygon(BaseModel):
    # Outer ring as list of [lon, lat] vertices.
    outer: list[list[float]]
    # Holes (e.g. islands within a bay). Each hole same shape as outer.
    # A point is "in water" if it's inside `outer` AND NOT inside any hole.
    holes: list[list[list[float]]] = []


class WaterPolygons(BaseModel):
    polygons: list[WaterPolygon]


async def fetch_water_polygons(bbox: Bbox) -> WaterPolygons:
    # natural=water covers oceans (named ones), seas, bays, lakes, ponds, reservoirs.
    # waterway=riverbank covers polygonal banks of larger rivers.
    # We grab both ways and relations because anything bigger than a pond is
    # usually a multipolygon relation in OSM.
    # Cover OSM's varied water tagging:
    #  - natural=water     → most lakes / ponds / explicit water polygons
    #  - natural=bay       → SF Bay and similar named bays (represented as bay polygon)
    #  - waterway=riverbank → polygonal banks of larger rivers
    #  - place=sea / ocean → named seas/oceans where polygonized
    # Open ocean bounded only by natural=coastline can't be detected from this
    # query alone; that case needs a coastline-aware polygon assembly which
    # we don't ship in v0.1.
    bbox_str = f"{bbox.south},{bbox.west},{bbox.north},{bbox.east}"
    tags_filter = (
        '["natural"~"^(water|bay)$"]',
        '["waterway"="riverbank"]',
        '["place"~"^(sea|ocean)$"]',
    )
    elements = []
    for tag in tags_filter:
        for kind in ("way", "relation"):
            elements.append(f"{kind}{tag}({bbox_str});")
    query = (
        "[out:json][timeout:25];"
        "("
        + "".join(elements)
        + ");"
        "out body;"
        ">;"
        "out skel qt;"
    )

    async with httpx.AsyncClient(timeout=OVERPASS_TIMEOUT_S) as client:
        r = await client.post(
            OVERPASS_URL,
            data={"data": query},
            headers={"User-Agent": "SpectralEye/0.1 (EW C2 demo)"},
        )
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Overpass returned {r.status_code}",
        )

    # osm2geojson assembles multipolygons properly using the bare-element response.
    geojson: dict[str, Any] = osm2geojson.json2geojson(r.json())

    polygons: list[WaterPolygon] = []
    for feature in geojson.get("features", []):
        geom = feature.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates") or []
        if gtype == "Polygon":
            # coords = [outer_ring, *inner_holes]
            if coords and len(coords[0]) >= 3:
                polygons.append(_build_polygon(coords))
        elif gtype == "MultiPolygon":
            # coords = [[outer_ring, *holes], [outer_ring, *holes], ...]
            for poly in coords:
                if poly and len(poly[0]) >= 3:
                    polygons.append(_build_polygon(poly))

    return WaterPolygons(polygons=polygons)


def _build_polygon(rings: list[Any]) -> WaterPolygon:
    outer = [list(p) for p in rings[0]]
    holes = [[list(p) for p in ring] for ring in rings[1:] if len(ring) >= 3]
    return WaterPolygon(outer=outer, holes=holes)
