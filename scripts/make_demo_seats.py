#!/usr/bin/env python3
"""Generate a synthetic auditorium whose seats are modelled INDIVIDUALLY, as a DXF.

    python3 scripts/make_demo_seats.py [out.dxf]

The companion to `make_demo_venue.py`, and the fixture the Rationalise panel exists for.
That one draws the stalls as a subdivided deck, which is the case the coplanar region
finder already handles perfectly: the faces touch, so they flood-fill into one plane.

This one draws what an architect's model actually contains — a separate seat solid per
seat, 468 of them, none touching any other. The region finder is then RIGHT to report
several hundred surfaces, and no tolerance setting will merge them, because the gap
between two seats is real geometry and not a crack to be welded shut. Rationalising is
the only way through, which is exactly what this file is here to show.

Two seating blocks, deliberately:

  * STALLS, on a smoothly raked floor, split by a centre gangway 1.8 m wide. Wider than
    any sensible bridging gap, so the two halves come out as two areas unless the gap is
    raised on purpose — the check that a rationalisation does not quietly pave a gangway.
  * BALCONY, on a STEPPED rake 4.4 m up. Every tread is separately level, so an average
    of the face normals would call it a flat floor; only a least-squares fit finds the
    real slope, and the residual it reports is the step height.

Everything is one layer per block, which is the other half of the point: a DXF keeps a
whole seating block on a single layer, so the object tree cannot separate the left bank
from the right and the drawn-area tool is the only way in.

**Nothing here is a real venue**, for the same reason as `make_demo_venue.py`.
"""

import math
import sys
from pathlib import Path

# Millimetres, declared in the header, matching the other demo file.
MM = 1000.0

SEAT_W = 0.48
SEAT_D = 0.45
SEAT_H = 0.42
ROW_PITCH = 0.90
COL_PITCH = 0.55


def face(layer, a, b, c, d=None):
    """One 3DFACE. A missing fourth corner repeats the third, per the DXF spec."""
    d = d if d is not None else c
    out = ["0", "3DFACE", "8", layer]
    for i, p in enumerate((a, b, c, d)):
        out += [str(10 + i), f"{p[0]:.4f}", str(20 + i), f"{p[1]:.4f}", str(30 + i), f"{p[2]:.4f}"]
    return out


def seat(layer, cx, cy, floor_z):
    """One seat as a closed box: a pan on top, an underside, and four sides.

    A solid rather than a bare pan on purpose. The capture filter's job is to keep the
    upward faces and drop the rest, and a fixture made only of pans would never test it —
    the seat backs and undersides here are what would drag a fitted plane down inside the
    seat if the filter were not doing its work.
    """
    out = []
    x0, x1 = cx - SEAT_D / 2, cx + SEAT_D / 2
    y0, y1 = cy - SEAT_W / 2, cy + SEAT_W / 2
    z0, z1 = floor_z, floor_z + SEAT_H

    top = [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    bottom = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]
    out += face(layer, *top)
    # Reversed, so its normal points down and the upward filter has something to reject.
    out += face(layer, bottom[3], bottom[2], bottom[1], bottom[0])
    for i in range(4):
        a, b = bottom[i], bottom[(i + 1) % 4]
        out += face(layer, a, b, (b[0], b[1], z1), (a[0], a[1], z1))
    return out


def build():
    e = []

    # --- Stage, so the room reads as a room and has something to aim at -------------
    sx0, sx1, sy, sz = -10.0, 0.0, 8.0, 1.0
    corners = [(sx0, -sy, sz), (sx1, -sy, sz), (sx1, sy, sz), (sx0, sy, sz)]
    e += face("STAGE", *corners)
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        e += face("STAGE", (a[0], a[1], 0.0), (b[0], b[1], 0.0), b, a)

    # --- Stalls: a smooth 1:14 rake, split by a centre gangway ----------------------
    # The floor itself is drawn, because a real plan has one and because it gives the
    # "all faces" capture something to find when "upward" is turned off.
    def floor_z(x):
        return 0.2 + (x - 2.0) / 14.0

    for i in range(18):
        x = 2.0 + i * ROW_PITCH
        for j in range(-13, 14):
            y = j * COL_PITCH
            # The gangway: no seat within 0.9 m of the centre line.
            if abs(y) < 0.9:
                continue
            e += seat("SEATING - STALLS", x, y, floor_z(x))

    def stalls_floor(u, v):
        x = 1.0 + u * 17.5
        return (x, (v - 0.5) * 16.0, floor_z(x))

    e += quad_grid("FLOOR - STALLS", stalls_floor, 14, 10)

    # --- Balcony: a STEPPED rake, every tread separately level ----------------------
    for i in range(8):
        x = 21.0 + i * 1.05
        z = 4.4 + i * 0.35
        for j in range(-11, 12):
            e += seat("SEATING - BALCONY", x, j * COL_PITCH, z)
        # The tread the row stands on, so the step is in the file and not just implied.
        e += face(
            "FLOOR - BALCONY",
            (x - 0.55, -6.6, z), (x + 0.55, -6.6, z), (x + 0.55, 6.6, z), (x - 0.55, 6.6, z),
        )

    return e


def quad_grid(layer, corner_fn, nu, nv):
    """Subdivide a parametric patch into nu x nv faces. Same helper as the other demo."""
    out = []
    for i in range(nu):
        for j in range(nv):
            u0, u1 = i / nu, (i + 1) / nu
            v0, v1 = j / nv, (j + 1) / nv
            out += face(layer, corner_fn(u0, v0), corner_fn(u1, v0), corner_fn(u1, v1), corner_fn(u0, v1))
    return out


def main(path):
    doc = (
        ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
         "0", "SECTION", "2", "ENTITIES"]
        + build()
        + ["0", "ENDSEC", "0", "EOF"]
    )
    # Coordinates above are in metres for legibility; $INSUNITS says millimetres, so
    # scale on the way out and let the importer read the header rather than guess.
    out = []
    for i in range(0, len(doc), 2):
        code, value = doc[i], doc[i + 1]
        if code in ("10", "11", "12", "13", "20", "21", "22", "23", "30", "31", "32", "33"):
            value = f"{float(value) * MM:.1f}"
        out += [code, value]

    Path(path).write_text("\n".join(out) + "\n")
    faces = sum(1 for i in range(0, len(doc), 2) if doc[i] == "0" and doc[i + 1] == "3DFACE")
    print(f"{path}: {faces} faces")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo/demo-seats.dxf")
