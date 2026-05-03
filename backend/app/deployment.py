"""Current-deployment reporting.

In real hardware, EW devices self-report their position and RF parameters
to the C2 platform (over a radio link, mesh network, MQTT broker, REST poll,
whatever). The C2 aggregates the reports and surfaces them as the operator's
current deployment picture.

For v0.1 we have no hardware, so SimulatedDeploymentSource fabricates a
plausible-looking deployment within the operator's AOI. The DeploymentSource
protocol exists so swapping the simulator for a real-hardware aggregator
later is a one-line replacement at the call site — the route, request/response
shape, and frontend integration all stay the same.

When real hardware arrives:
  1. Implement HardwareDeploymentSource(DeploymentSource) that reads from your
     actual data feed (MQTT topic, REST gateway, mesh radio adapter, etc.)
  2. Swap the instance returned by `get_deployment_source()`
  3. Done — frontend keeps calling /deployment/current the same way.
"""

from __future__ import annotations

import random
from typing import Literal, Protocol

from pydantic import BaseModel, Field

AssetTypeLiteral = Literal["jammer", "sensor", "relay"]


class Bbox(BaseModel):
    west: float = Field(..., ge=-180, le=180)
    south: float = Field(..., ge=-90, le=90)
    east: float = Field(..., ge=-180, le=180)
    north: float = Field(..., ge=-90, le=90)


class AssetReport(BaseModel):
    """A single device's self-report. height_agl is meters above ground level —
    the frontend resolves that to an absolute height by sampling terrain +
    building geometry at (longitude, latitude)."""

    type: AssetTypeLiteral
    longitude: float
    latitude: float
    height_agl: float
    frequency_mhz: float
    erp_dbm: float
    label: str | None = None


class DeploymentReport(BaseModel):
    reports: list[AssetReport]
    source: Literal["simulated", "hardware"]


class DeploymentSource(Protocol):
    async def fetch_current_deployment(self, bbox: Bbox) -> DeploymentReport: ...


class SimulatedDeploymentSource:
    """Fabricates a minimal triad EW posture inside the AOI: exactly one of
    each asset type, randomly placed.

      - 1 perimeter jammer near the AOI centre
      - 1 RF sensor placed anywhere in the AOI
      - 1 comms relay placed anywhere in the AOI

    Earlier revisions returned 5-7 assets with bonus randomness; this was
    reduced to a fixed one-of-each set so demos start from a predictable,
    legible deployment regardless of the AOI seed.
    """

    # Devices are mounted ON whatever surface they're at (rooftop or ground), not
    # floating above. height_agl is just a small clearance to avoid z-fighting.
    SURFACE_CLEARANCE_M = 1.0

    async def fetch_current_deployment(self, bbox: Bbox) -> DeploymentReport:
        rng = random.Random()
        reports: list[AssetReport] = [
            # Perimeter jammer near AOI center (jitter < 1 pulls toward middle).
            self._make_asset(
                "jammer",
                bbox,
                rng,
                erp_range=(45, 55),
                freq=2400,
                label="JAM-01",
                jitter=0.2,
            ),
            # RF sensor anywhere in the AOI.
            self._make_asset(
                "sensor",
                bbox,
                rng,
                erp_range=(0, 0),
                freq=rng.choice([2400, 5800]),
                label="SEN-01",
            ),
            # Comms relay anywhere in the AOI.
            self._make_asset(
                "relay",
                bbox,
                rng,
                erp_range=(25, 35),
                freq=5800,
                label="RLY-01",
            ),
        ]
        return DeploymentReport(reports=reports, source="simulated")

    def _make_asset(
        self,
        kind: AssetTypeLiteral,
        bbox: Bbox,
        rng: random.Random,
        *,
        erp_range: tuple[float, float],
        freq: float,
        label: str,
        jitter: float = 1.0,
    ) -> AssetReport:
        """Pick a position within the bbox, biased by `jitter` toward the center
        (jitter=1.0 means uniform; jitter<1.0 pulls toward center)."""
        cx = (bbox.west + bbox.east) / 2
        cy = (bbox.south + bbox.north) / 2
        half_w = (bbox.east - bbox.west) / 2 * jitter
        half_h = (bbox.north - bbox.south) / 2 * jitter
        lon = cx + rng.uniform(-half_w, half_w)
        lat = cy + rng.uniform(-half_h, half_h)
        erp = rng.uniform(*erp_range)
        return AssetReport(
            type=kind,
            longitude=lon,
            latitude=lat,
            height_agl=self.SURFACE_CLEARANCE_M,
            frequency_mhz=freq,
            erp_dbm=erp,
            label=label,
        )


# Module-level instance — replace this binding with HardwareDeploymentSource()
# (or wire a factory in main.py via dependency injection) when real devices arrive.
_default_source: DeploymentSource = SimulatedDeploymentSource()


def get_deployment_source() -> DeploymentSource:
    return _default_source
