"""Generate the Sionna RT Colab notebook.

Run with `python colab/build_notebook.py` to produce
`colab/spectraleye_sionna.ipynb`.

The notebook itself is the artifact; this script is the source-of-truth
because cell content is much easier to edit as Python strings than as
escaped JSON inside an .ipynb.
"""

from __future__ import annotations

import json
from pathlib import Path

# ---------------------------------------------------------------------------
# Cell content
# ---------------------------------------------------------------------------

INTRO_MD = """# SpectralEye — Sionna RT coverage server

This Colab notebook hosts the **real Sionna RT** ray-traced coverage backend
for SpectralEye. Your local FastAPI backend POSTs `/coverage/sionna` requests
to a public URL printed by the last cell; this notebook computes the
ray-traced 3D path-loss field for the asset and returns it.

Pipeline per request:

1. Fetch OSM building footprints for the AOI bbox via Overpass.
2. Build a **closed-volume** Mitsuba scene (solid building meshes, asphalt
   ground plane) using triangulated caps + walls.
3. Load into Sionna RT, place a transmitter at the asset position.
4. Compute coverage maps at multiple altitudes, stack into a 3D path-loss grid.
5. Return base64-encoded float32 grid in the same shape as the local mock.

Same API as the local mock — backend swaps implementations transparently.
"""

SETUP_MD = """## Step 1 — Configure the runtime

Before running anything, switch this notebook to a GPU runtime:

  **Runtime → Change runtime type → T4 GPU** (or A100 if you have Pro+).

Sionna RT requires CUDA. Without a GPU runtime, the install will succeed but
ray tracing will be unusably slow.

Then run all cells in order. The install cell takes ~3-4 minutes the first
time; subsequent runs reuse the cached environment for the session.
"""

INSTALL_CODE = '''# Install Sionna RT, Mitsuba 3 (its renderer), OSM HTTP client, FastAPI server,
# triangulation lib, and cloudflared for the public tunnel.
#
# numpy<2.1 pinned because pip upgrading numpy mid-install (to satisfy a
# transient sionna dep) leaves numpy in a half-upgraded state on disk —
# the kernel reload then fails with "cannot import _center from
# numpy._core.umath". Pinning here forces a clean version up-front.
!pip install -q "numpy<2.1" sionna mitsuba shapely requests mapbox-earcut fastapi "uvicorn[standard]" nest-asyncio pydantic

# cloudflared binary for the tunnel (no signup required, free).
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /content/cloudflared
!chmod +x /content/cloudflared

# Sionna's deps upgrade numpy/tensorflow in-place; the running kernel still
# has the OLD modules cached, which produces "cannot import name _center
# from numpy._core.umath" on the next cell. The kernel MUST be restarted
# before importing anything from sionna/numpy.
#
# Auto-restart (IPython.Application.instance().kernel.do_shutdown) races
# with absl.logging atexit handlers and produces an infinite restart loop,
# so we make it manual. Do exactly what the printed message says.
print()
print("=" * 70)
print("  INSTALL COMPLETE — MANUAL RESTART REQUIRED")
print()
print("  Top menu:  Runtime  ->  Restart session")
print()
print("  After 'Connected' shows again, run cells from STEP 2 onwards.")
print("  Do NOT re-run this install cell.")
print("=" * 70)
'''

IMPORTS_MD = """## Step 2 — Imports and shared config

**Before running this cell**, restart the runtime via menu:

  **Runtime → Restart session**

Then run this cell (and the next ones). Do not re-run the install cell.

If this cell errors with `cannot import name '_center' from
numpy._core.umath`, the kernel wasn't actually restarted. Restart again.

If it errors with a CUDA-related message, re-check the GPU runtime
selection in Step 1.
"""

IMPORTS_CODE = '''import asyncio
import base64
import math
import os
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Literal

import numpy as np
import requests
import mapbox_earcut as earcut
import sionna
import sionna.rt as rt
from sionna.rt import (
    Camera,
    PlanarArray,
    Receiver,
    Scene,
    Transmitter,
    load_scene,
)

# Sionna defaults to TF; tell it to use the available GPU.
import tensorflow as tf
gpus = tf.config.list_physical_devices("GPU")
if gpus:
    tf.config.experimental.set_memory_growth(gpus[0], True)
    print(f"Using GPU: {gpus[0].name}")
else:
    print("WARNING: no GPU detected — Sionna will run on CPU and be very slow")

SCENE_DIR = "/content/scene"
os.makedirs(SCENE_DIR, exist_ok=True)
print("Sionna version:", sionna.__version__)
'''

SCENE_MD = """## Step 3 — OSM → Mitsuba scene builder

Builds a Mitsuba scene XML for an AOI bbox:

- Queries Overpass for `building=*` footprints in the bbox.
- For each building: triangulates the footprint with earcut, generates the
  bottom cap, top cap, and wall quads → **closed-volume solid mesh** so
  Sionna ray tracing treats the building interior as opaque.
- Adds a flat asphalt ground plane covering the AOI extent.
- Wires both shapes to ITU radio materials (`itu_concrete` for buildings,
  `itu_concrete` for ground — refine later for asphalt-specific properties).

Coordinates are local Cartesian (meters from AOI center) so Sionna can ray
trace in a flat reference frame.
"""

SCENE_CODE = '''OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def _to_local_frame(center_lon, center_lat):
    deg_per_m_lat = 1.0 / 111_320.0
    deg_per_m_lon = 1.0 / (111_320.0 * math.cos(math.radians(center_lat)))
    def to_local(lon, lat):
        x = (lon - center_lon) / deg_per_m_lon
        y = (lat - center_lat) / deg_per_m_lat
        return x, y
    return to_local


def _building_height(tags):
    if "height" in tags:
        try:
            return float(tags["height"])
        except (ValueError, TypeError):
            pass
    if "building:height" in tags:
        try:
            return float(tags["building:height"])
        except (ValueError, TypeError):
            pass
    if "building:levels" in tags:
        try:
            return float(tags["building:levels"]) * 3.0
        except (ValueError, TypeError):
            pass
    return 10.0  # default 1-story-ish if unknown


def _write_ply(path, vertices, faces):
    with open(path, "w") as f:
        f.write("ply\\nformat ascii 1.0\\n")
        f.write(f"element vertex {len(vertices)}\\n")
        f.write("property float x\\nproperty float y\\nproperty float z\\n")
        f.write(f"element face {len(faces)}\\n")
        f.write("property list uchar int vertex_indices\\n")
        f.write("end_header\\n")
        for x, y, z in vertices:
            f.write(f"{x} {y} {z}\\n")
        for tri in faces:
            f.write(f"3 {tri[0]} {tri[1]} {tri[2]}\\n")


# Cache the per-AOI building footprints+heights so compute_coverage_grid can
# look up the building under the TX and place the transmitter ABOVE its
# rooftop in the local Sionna frame (without this, a TX placed on a tower
# from Cesium ends up buried inside the same building in the Sionna scene).
_BUILDING_CACHE = {}

# Cache the FULL built scene (Mitsuba XML path + local frame center) per AOI
# bbox so multiple coverage requests for the same AOI don't each re-query
# Overpass. Critical when the operator has multiple jammers / sensors / relays
# and triggers all their coverage fetches at once — without this cache, the
# second+ requests trip Overpass's per-IP rate limit (HTTP 429) and the user
# silently loses coverage for all but the first asset.
_SCENE_CACHE = {}


def _point_in_polygon(x, y, poly):
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def building_height_at(x, y, polygons):
    """Returns the height of the building at local (x, y), or 0 if no building."""
    for h, poly in polygons:
        if _point_in_polygon(x, y, poly):
            return h
    return 0.0


def build_scene(bbox):
    """bbox: dict with west/south/east/north in degrees. Returns (scene_path, center).

    Cache hit on `_SCENE_CACHE[bbox]` returns immediately — no Overpass query,
    no PLY rewrite, no Mitsuba XML rebuild. This is what lets a "Show
    Contested Airspace" toggle (which fires a coverage request for every
    jammer at once) survive Overpass's per-IP rate limit: only the first
    request actually queries OSM."""
    south, west, north, east = bbox["south"], bbox["west"], bbox["north"], bbox["east"]
    cache_key = (round(west, 5), round(south, 5), round(east, 5), round(north, 5))
    if cache_key in _SCENE_CACHE:
        print(f"Scene cache HIT for {cache_key} — skipping Overpass query")
        return _SCENE_CACHE[cache_key]

    center_lat = (south + north) / 2
    center_lon = (west + east) / 2
    to_local = _to_local_frame(center_lon, center_lat)

    # Use body + recursive nodes — the public Overpass server returned 406
    # to overpy's stricter Accept headers from Colab IPs, and `out geom;`
    # produced inconsistent inline geometry for some ways. body + ;>; gets
    # ways AND their referenced nodes separately, more robust.
    query = f"""
    [out:json][timeout:30];
    (
      way["building"]({south},{west},{north},{east});
    );
    out body;
    >;
    out skel qt;
    """
    print(f"Querying OSM for buildings in {bbox}...")
    r = requests.post(
        OVERPASS_URL,
        data={"data": query},
        headers={"User-Agent": "SpectralEye/0.1 (EW C2 demo)", "Accept": "application/json"},
        timeout=60,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Overpass {r.status_code}: {r.text[:300]}")
    elements = r.json().get("elements", [])

    nodes = {e["id"]: (e["lon"], e["lat"]) for e in elements if e.get("type") == "node"}
    ways = [e for e in elements if e.get("type") == "way" and "building" in (e.get("tags") or {})]
    print(f"OSM returned {len(elements)} elements, {len(nodes)} nodes, {len(ways)} buildings")

    vertices = []
    faces = []
    building_polygons = []  # (height, [(x_local, y_local), ...]) for TX height lookup
    for way in ways:
        height = _building_height(way.get("tags", {}))
        node_ids = way.get("nodes", [])
        if len(node_ids) < 4:
            continue
        try:
            coords = [to_local(*nodes[n]) for n in node_ids]
        except KeyError:
            continue
        if coords[0] == coords[-1]:
            coords = coords[:-1]
        if len(coords) < 3:
            continue

        # mapbox_earcut needs a 2D (N, 2) array of vertices — passing a flat
        # 1D array silently returns empty, which would skip every building.
        verts_2d = np.array(coords, dtype=np.float64)
        rings = np.array([len(coords)], dtype=np.uint32)
        try:
            tris_flat = earcut.triangulate_float64(verts_2d, rings)
        except Exception:
            continue
        if tris_flat is None or len(tris_flat) == 0:
            continue
        cap_tris = tris_flat.reshape(-1, 3)

        building_polygons.append((height, list(coords)))

        n = len(coords); v0 = len(vertices)
        for x, y in coords:
            vertices.append((x, y, 0.0))
        for x, y in coords:
            vertices.append((x, y, height))
        for tri in cap_tris:
            faces.append((v0 + int(tri[0]), v0 + int(tri[2]), v0 + int(tri[1])))
        for tri in cap_tris:
            faces.append((v0 + n + int(tri[0]), v0 + n + int(tri[1]), v0 + n + int(tri[2])))
        for i in range(n):
            a = v0 + i; b = v0 + (i + 1) % n
            c = v0 + n + (i + 1) % n; d = v0 + n + i
            faces.append((a, b, c)); faces.append((a, c, d))

    print(f"Built {len(vertices)} vertices, {len(faces)} triangles for {len(building_polygons)} buildings")

    _write_ply(os.path.join(SCENE_DIR, "buildings.ply"), vertices, faces)

    # Ground plane: 2x AOI extent (so transmitters at the edge still hit ground).
    half_w = (east - west) * 111_320 * math.cos(math.radians(center_lat))
    half_h = (north - south) * 111_320
    g_verts = [
        (-half_w, -half_h, 0.0), (half_w, -half_h, 0.0),
        (half_w, half_h, 0.0), (-half_w, half_h, 0.0),
    ]
    g_faces = [(0, 1, 2), (0, 2, 3)]
    _write_ply(os.path.join(SCENE_DIR, "ground.ply"), g_verts, g_faces)

    # face_normals=true tells Mitsuba to compute flat normals from triangle
    # geometry — required because our PLY writer doesn't include vertex
    # normals and Mitsuba 3 refuses to add them post-load.
    xml = """<?xml version="1.0" encoding="utf-8"?>
<scene version="2.1.0">
  <bsdf type="diffuse" id="itu_concrete">
    <rgb name="reflectance" value="0.5 0.5 0.5"/>
  </bsdf>
  <shape type="ply" id="ground">
    <string name="filename" value="ground.ply"/>
    <boolean name="face_normals" value="true"/>
    <ref id="itu_concrete"/>
  </shape>
  <shape type="ply" id="buildings">
    <string name="filename" value="buildings.ply"/>
    <boolean name="face_normals" value="true"/>
    <ref id="itu_concrete"/>
  </shape>
</scene>
"""
    scene_path = os.path.join(SCENE_DIR, "scene.xml")
    with open(scene_path, "w") as f:
        f.write(xml)

    # cache_key already computed at the top of build_scene for the early-return
    # check. Reuse the same value for both caches so they stay aligned.
    _BUILDING_CACHE[cache_key] = building_polygons
    result = (scene_path, (center_lon, center_lat))
    _SCENE_CACHE[cache_key] = result
    return result


print("Scene builder ready.")
'''

RUNNER_MD = """## Step 4 — Sionna RT runner

Loads the Mitsuba scene, places the asset transmitter, then runs Sionna's
`RadioMapSolver` once per Z slice (multi-altitude sweep) and stacks the 2D
coverage maps into a true 3D path-loss field. Coverage volumes correctly
bulge around buildings at each altitude — the visible "shadow tunnel"
behind a tall building only opens up above the rooftop, not below it.

The TX is auto-placed above any building it sits on top of (using the OSM
height cache from Step 3) so a jammer dropped on a tower doesn't end up
buried inside its own walls in the local Sionna frame.
"""

RUNNER_CODE = '''import mitsuba as mi
from sionna.rt import RadioMapSolver

SENSOR_REFERENCE_ERP_DBM = 30.0


def compute_coverage_grid(asset, grid_spec, scene_path, scene_center):
    """Returns (values_flat_float32, nx, ny, nz).

    Multi-altitude sweep — runs Sionna's RadioMapSolver once per Z slice and
    stacks the results into a true 3D path-loss field. Slower than the
    single-altitude approximation (one solver call per slice ≈ 2-4 s on T4)
    but coverage volumes correctly bulge around buildings at each altitude.
    """
    center_lon, center_lat = scene_center
    deg_per_m_lat = 1.0 / 111_320.0
    deg_per_m_lon = 1.0 / (111_320.0 * math.cos(math.radians(center_lat)))

    bbox = grid_spec["bbox"]
    width_m = (bbox["east"] - bbox["west"]) / deg_per_m_lon
    height_m = (bbox["north"] - bbox["south"]) / deg_per_m_lat
    voxel = grid_spec["voxel_size_m"]
    nx = max(1, int(math.ceil(width_m / voxel)))
    ny = max(1, int(math.ceil(height_m / voxel)))
    nz = max(1, int(math.ceil((grid_spec["height_max_m"] - grid_spec["height_min_m"]) / voxel)))

    tx_x = (asset["longitude"] - center_lon) / deg_per_m_lon
    tx_y = (asset["latitude"] - center_lat) / deg_per_m_lat

    # The asset height from the frontend is a WGS84 ellipsoidal height; the
    # Sionna scene origin is the local ground plane at z=0. Naively using
    # asset["height"] buries the TX below ground (geoid offset is ~-32m in
    # SF). Place the TX above the rooftop of the building it sits on, or
    # at 5 m AGL otherwise (low-mounted ground asset).
    #
    # The building cache + lookup helper live in the scene builder cell. If
    # this runner cell is executed before that cell (or if the user has an
    # older notebook layout without those symbols), fall back to a flat 5 m
    # AGL placement instead of erroring out — coverage will be omnidirectional
    # but the request still succeeds.
    try:
        cache_key = (round(bbox["west"], 5), round(bbox["south"], 5),
                     round(bbox["east"], 5), round(bbox["north"], 5))
        polygons = _BUILDING_CACHE.get(cache_key, [])
        bh = building_height_at(tx_x, tx_y, polygons)
    except NameError:
        bh = 0.0
        print("  WARN: _BUILDING_CACHE / building_height_at not defined — "
              "re-run the scene builder cell for accurate TX placement")
    tx_z = bh + 2.0 if bh > 0 else 5.0
    print(f"  TX placed at local ({tx_x:.1f}, {tx_y:.1f}, {tx_z:.1f}) "
          f"[building height: {bh:.1f}m]")

    scene = load_scene(scene_path)
    scene.frequency = float(asset["frequency_mhz"]) * 1e6
    scene.tx_array = PlanarArray(
        num_rows=1, num_cols=1,
        vertical_spacing=0.5, horizontal_spacing=0.5,
        pattern="iso", polarization="V",
    )
    scene.rx_array = PlanarArray(
        num_rows=1, num_cols=1,
        vertical_spacing=0.5, horizontal_spacing=0.5,
        pattern="iso", polarization="V",
    )
    scene.add(Transmitter(name="tx0", position=[tx_x, tx_y, tx_z]))

    rm_solver = RadioMapSolver()
    erp_dbm = (
        float(asset["erp_dbm"])
        if asset["type"] != "sensor"
        else SENSOR_REFERENCE_ERP_DBM
    )
    erp_linear = 10 ** ((erp_dbm - 30) / 10)
    eps = 1e-30

    # Solver kwargs tuned for the multi-altitude sweep:
    #  - samples_per_tx=2e6: high enough that thin/distant cells don't drop
    #    to -inf gain (which would clamp to the noise floor and lose contrast)
    #  - refraction=False: through-wall propagation is irrelevant for
    #    outdoor EW assets and roughly doubles solver time when enabled
    #  - diffuse_reflection=True: keeps soft shadow falloff behind buildings
    # Some Sionna 1.x builds reject one or both kwargs; fall back gracefully.
    base_kwargs = dict(
        scene=scene,
        max_depth=3,
        cell_size=(voxel, voxel),
        size=mi.Point2f(width_m, height_m),
        samples_per_tx=int(2e6),
    )

    rx_dbm_3d = np.empty((nx, ny, nz), dtype=np.float32)
    for k in range(nz):
        z = grid_spec["height_min_m"] + (k + 0.5) * voxel
        slice_kwargs = dict(
            base_kwargs,
            center=mi.Point3f(0.0, 0.0, z),
            orientation=mi.Point3f(0.0, 0.0, 0.0),
        )
        try:
            rm = rm_solver(**slice_kwargs, refraction=False, diffuse_reflection=True)
        except TypeError:
            try:
                rm = rm_solver(**slice_kwargs, refraction=False)
            except TypeError:
                rm = rm_solver(**slice_kwargs)
        gain = rm.path_gain.numpy()[0]  # (ny, nx)
        rx_dbm_3d[:, :, k] = (
            10.0 * np.log10(np.maximum(gain * erp_linear, eps)) + 30.0
        ).T

    return rx_dbm_3d.ravel(order="C"), nx, ny, nz


print("Sionna runner ready (multi-altitude sweep).")
'''

SELFTEST_MD = """## Step 5 — Self-test the pipeline

Runs build_scene + compute_coverage_grid against a small test asset over an
SF bbox. If this cell errors, the FastAPI server in the next cell will too;
fix the error here first so the traceback is visible directly in this cell
output (not buried inside a 500 from the FastAPI handler).
"""

SELFTEST_CODE = '''_test_asset = {
    "type": "jammer", "longitude": -122.4194, "latitude": 37.7749,
    "height": 50.0, "frequency_mhz": 2400.0, "erp_dbm": 50.0,
}
_test_grid_spec = {
    "bbox": {"west": -122.435, "south": 37.770, "east": -122.405, "north": 37.785},
    "voxel_size_m": 25.0, "height_min_m": 0.0, "height_max_m": 200.0,
}

try:
    _scene_path, _scene_center = build_scene(_test_grid_spec["bbox"])
    print(f"OK scene built: {_scene_path}, center {_scene_center}")
    _flat, _nx, _ny, _nz = compute_coverage_grid(
        _test_asset, _test_grid_spec, _scene_path, _scene_center
    )
    print(f"OK coverage grid {_nx}x{_ny}x{_nz}, {len(_flat)} voxels")
    print(f"   path-loss range: {_flat.min():.1f} to {_flat.max():.1f} dBm")
except Exception:
    traceback.print_exc()
'''

API_MD = """## Step 6 — FastAPI server

The same `/coverage/sionna` route the local backend exposes. Local backend's
`RemoteSionnaSource` POSTs requests here.

The scene is rebuilt per request (one OSM fetch, one mesh build); for typical
city-block AOIs this is ~5-15 seconds. Production would cache by AOI.
"""

API_CODE = '''import nest_asyncio
nest_asyncio.apply()

from fastapi import FastAPI
from pydantic import BaseModel, Field
import uvicorn

class _Bbox(BaseModel):
    west: float
    south: float
    east: float
    north: float

class _AssetParams(BaseModel):
    type: str
    longitude: float
    latitude: float
    height: float
    frequency_mhz: float
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


app = FastAPI(title="SpectralEye Sionna Coverage Server")

# Serialize coverage compute. Two reasons:
#   1. build_scene() writes /content/scene/{scene.xml,buildings.ply,ground.ply}
#      to a single fixed path. Concurrent requests race on these files —
#      one open(..., "w") truncates a file mid-read in the other handler,
#      and Sionna's load_scene then chokes on an empty XML
#      ("ParseError: no element found").
#   2. The Colab T4 has a single GPU; truly parallel Sionna RT computes
#      contend for it anyway, so serial requests are about the same wall
#      time but never deadlock the renderer.
# The frontend's bounded worker pool fires 2 requests at once; the lock
# turns those into back-to-back compute, which the cloudflared free-tier
# timeout handles fine for typical AOIs.
_COVERAGE_LOCK = asyncio.Lock()


@app.get("/health")
def health():
    return {"status": "ok", "source": "sionna_remote", "gpu": bool(gpus)}


@app.post("/coverage/sionna")
async def coverage(req: _CoverageRequest):
    bbox = req.grid_spec.bbox.model_dump()
    asset = req.asset.model_dump()
    grid_spec = req.grid_spec.model_dump()
    grid_spec["bbox"] = bbox

    async with _COVERAGE_LOCK:
        return _run_coverage(bbox, asset, grid_spec)


def _run_coverage(bbox, asset, grid_spec):
    try:
        t0 = time.time()
        scene_path, scene_center = build_scene(bbox)
        print(f"Scene built in {time.time() - t0:.1f}s")

        t1 = time.time()
        flat, nx, ny, nz = compute_coverage_grid(asset, grid_spec, scene_path, scene_center)
        print(f"Sionna coverage computed in {time.time() - t1:.1f}s ({nx}x{ny}x{nz})")

        encoded = base64.b64encode(flat.tobytes()).decode("ascii")
        return {
            "values_b64": encoded,
            "nx": nx, "ny": ny, "nz": nz,
            "bbox": bbox,
            "height_min_m": grid_spec["height_min_m"],
            "height_max_m": grid_spec["height_min_m"] + nz * grid_spec["voxel_size_m"],
            "voxel_size_m": grid_spec["voxel_size_m"],
            "units": "dBm",
            "source": "sionna_remote",
            "computed_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception:
        # Surface the traceback in the response body so the local backend's
        # error log shows the actual cause (otherwise FastAPI hides it as
        # "Internal Server Error" and we have to scrape the cell stdout).
        tb = traceback.format_exc()
        print(tb)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=tb[-1500:])


def _run_server():
    # Drive the coroutine in our own event loop. Bypass uvicorn's Server.run()
    # which calls asyncio.run with a loop_factory kwarg that nest_asyncio's
    # patched asyncio.run doesn't accept.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    config = uvicorn.Config(app, host="0.0.0.0", port=8765, log_level="info", loop="asyncio")
    server = uvicorn.Server(config)
    loop.run_until_complete(server.serve())


threading.Thread(target=_run_server, daemon=True).start()
time.sleep(2)
print("FastAPI server running on port 8765 inside notebook.")
'''

TUNNEL_MD = """## Step 7 — Public URL via cloudflared tunnel

Cloudflare's `cloudflared` exposes the notebook's port 8765 to the internet
on a temporary public HTTPS URL. No signup or auth required.

After this cell runs, **copy the printed URL** (looks like
`https://<random-words>.trycloudflare.com`) and paste it into your local
`backend/.env` as `SIONNA_REMOTE_URL=https://...`. Then restart the local
backend.
"""

TUNNEL_CODE = '''import subprocess
import re

# Start cloudflared in background.
proc = subprocess.Popen(
    ["/content/cloudflared", "tunnel", "--url", "http://localhost:8765"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)

# Watch the output for the public URL line.
url = None
deadline = time.time() + 30
while time.time() < deadline:
    line = proc.stdout.readline()
    if not line:
        time.sleep(0.2)
        continue
    print(line, end="")
    m = re.search(r"https://[a-zA-Z0-9-]+\\.trycloudflare\\.com", line)
    if m:
        url = m.group(0)
        break

if url:
    print()
    print("=" * 70)
    print(f"PUBLIC URL: {url}")
    print()
    print("Paste this into your LOCAL backend/.env file as:")
    print(f"  SIONNA_REMOTE_URL={url}")
    print("Then restart the local backend.")
    print("=" * 70)
else:
    print("ERROR: did not detect a cloudflared URL within 30 seconds.")
    print("Check the output above for errors.")
'''

USAGE_MD = """## Step 8 — Verifying the connection

After pasting the URL into `backend/.env` and restarting the local backend:

1. In the SpectralEye UI, mark an AOI and place an asset (or use Report
   Current Deployment).
2. Click **Show EMS** or **Show EMS Footprint** on an asset.
3. The local backend will POST to this notebook's URL; you should see the
   request logged in this cell's output (`Querying OSM…` then
   `Sionna coverage computed in Xs`).
4. The coverage volume in the 3D scene now reflects ray-traced values
   (sharp shadows behind buildings, multipath effects), distinct from the
   smooth spherical mock.

To stop: just close the notebook tab. The cloudflared tunnel and FastAPI
server stop with the runtime.

To restart: re-run all cells; the printed URL **will be different** each
session, so re-paste it into `backend/.env` and restart the local backend.
"""


# ---------------------------------------------------------------------------
# Notebook assembly
# ---------------------------------------------------------------------------

def md_cell(text: str) -> dict:
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": text.splitlines(keepends=True),
    }


def code_cell(text: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": text.splitlines(keepends=True),
    }


def build() -> dict:
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "colab": {"provenance": [], "gpuType": "T4"},
            "kernelspec": {"display_name": "Python 3", "name": "python3"},
            "language_info": {"name": "python"},
            "accelerator": "GPU",
        },
        "cells": [
            md_cell(INTRO_MD),
            md_cell(SETUP_MD),
            code_cell(INSTALL_CODE),
            md_cell(IMPORTS_MD),
            code_cell(IMPORTS_CODE),
            md_cell(SCENE_MD),
            code_cell(SCENE_CODE),
            md_cell(RUNNER_MD),
            code_cell(RUNNER_CODE),
            md_cell(SELFTEST_MD),
            code_cell(SELFTEST_CODE),
            md_cell(API_MD),
            code_cell(API_CODE),
            md_cell(TUNNEL_MD),
            code_cell(TUNNEL_CODE),
            md_cell(USAGE_MD),
        ],
    }


if __name__ == "__main__":
    out = Path(__file__).parent / "spectraleye_sionna.ipynb"
    out.write_text(json.dumps(build(), indent=1) + "\n")
    print(f"Wrote {out}")
