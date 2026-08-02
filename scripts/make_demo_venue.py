#!/usr/bin/env python3
"""Generate a synthetic auditorium as a DXF, for demos, screenshots and the video.

    python3 scripts/make_demo_venue.py [out.dxf]

**Nothing here is a real venue.** The reference file this project was reverse-engineered
from is somebody's actual theatre, and it is fine as a test fixture but must not appear
in a public video or a screenshot — the same reason the PMSE tool films an invented
licence rather than a real one. This builds an obviously-fictional room with the same
shape of problem: a raked stalls deck, a curved balcony, splayed side walls, a ceiling,
a stage, and a lighting bar that exists to be pruned.

It is also the honest demo. The tool's claim is that it reduces tens of thousands of CAD
triangles to a few dozen ArrayCalc planes, and a hand-made file with forty triangles in
it would not demonstrate that. The seating decks here are subdivided the way a real CAD
export subdivides them, so the reduction on screen is a real reduction.

Written as 3DFACE entities on named layers, because that is the DXF subset every CAD
package emits and the one ArrayCAD's importer treats as exact.
"""

import math
import sys
from pathlib import Path

# Millimetres, declared in the header, because that is what a venue drawing usually is
# and it exercises the unit path rather than dodging it.
MM = 1000.0


def face(layer, a, b, c, d=None):
    """One 3DFACE. A missing fourth corner repeats the third, per the DXF spec."""
    d = d if d is not None else c
    out = ["0", "3DFACE", "8", layer]
    for i, p in enumerate((a, b, c, d)):
        out += [str(10 + i), f"{p[0]:.4f}", str(20 + i), f"{p[1]:.4f}", str(30 + i), f"{p[2]:.4f}"]
    return out


def quad_grid(layer, corner_fn, nu, nv):
    """Subdivide a parametric patch into nu x nv faces.

    `corner_fn(u, v)` takes two 0..1 parameters and returns a point. Subdividing is the
    point: a CAD package does not emit one big quad for a raked deck, it emits a mesh,
    and the tool's job is to put it back together.
    """
    out = []
    for i in range(nu):
        for j in range(nv):
            u0, u1 = i / nu, (i + 1) / nu
            v0, v1 = j / nv, (j + 1) / nv
            out += face(
                layer,
                corner_fn(u0, v0),
                corner_fn(u1, v0),
                corner_fn(u1, v1),
                corner_fn(u0, v1),
            )
    return out


def build():
    e = []

    # --- Stage: a box at the -X end, which is where ArrayCalc expects it ------------
    sx0, sx1 = -12.0, 0.0
    sy = 9.0
    sz = 1.0
    corners = [(sx0, -sy, sz), (sx1, -sy, sz), (sx1, sy, sz), (sx0, sy, sz)]
    e += face("STAGE", *corners)
    for i in range(4):
        a = corners[i]
        b = corners[(i + 1) % 4]
        e += face("STAGE", (a[0], a[1], 0.0), (b[0], b[1], 0.0), b, a)

    # --- Stalls: a raked deck fanning out from the stage ----------------------------
    # Rises 1:12 towards the back, and widens — the shape that makes a single flat
    # rectangle the wrong answer and a plane the right one.
    def stalls(u, v):
        x = 1.0 + u * 22.0
        half = 8.0 + u * 5.0
        y = (v - 0.5) * 2 * half
        z = u * 22.0 / 12.0
        return (x, y, z)

    e += quad_grid("SEATING - STALLS", stalls, 24, 18)

    # --- Balcony: a curved raked tier over the back of the stalls -------------------
    def balcony(u, v):
        r = 17.0 + u * 7.0
        ang = math.radians(-52 + v * 104)
        x = 6.0 + r * math.cos(ang)
        y = r * math.sin(ang)
        z = 7.0 + u * 7.0 / 9.0
        return (x, y, z)

    e += quad_grid("SEATING - BALCONY", balcony, 16, 28)

    # --- Balcony front: the vertical face under it ---------------------------------
    def balcony_front(u, v):
        r = 17.0
        ang = math.radians(-52 + u * 104)
        return (6.0 + r * math.cos(ang), r * math.sin(ang), 7.0 - v * 1.6)

    e += quad_grid("BALCONY RAIL", balcony_front, 28, 2)

    # --- Side walls: splayed, so they are neither axis-aligned nor vertical-only ----
    for side in (-1, 1):
        def wall(u, v, side=side):
            x = 1.0 + u * 22.0
            half = 8.6 + u * 5.4
            return (x, side * half, v * 12.0)

        e += quad_grid("WALLS", wall, 20, 6)

    # --- Rear wall -----------------------------------------------------------------
    def rear(u, v):
        return (23.0, (u - 0.5) * 28.0, v * 12.0)

    e += quad_grid("WALLS", rear, 14, 6)

    # --- Ceiling: shallow vault, so it is genuinely curved and must break into --------
    # several planes rather than one.
    def ceiling(u, v):
        x = -12.0 + u * 35.0
        y = (v - 0.5) * 28.0
        z = 12.0 + 1.8 * math.cos((v - 0.5) * math.pi)
        return (x, y, z)

    e += quad_grid("CEILING", ceiling, 20, 16)

    # --- Lighting bar: a box, and the thing the video prunes ------------------------
    for n, bx in enumerate((-6.0, 2.0, 10.0)):
        b0 = (bx - 0.25, -11.0, 10.4)
        b1 = (bx + 0.25, 11.0, 11.0)
        pts = [
            (b0[0], b0[1], b0[2]), (b1[0], b0[1], b0[2]),
            (b1[0], b1[1], b0[2]), (b0[0], b1[1], b0[2]),
        ]
        top = [(p[0], p[1], b1[2]) for p in pts]
        e += face("LIGHTING BARS", *pts)
        e += face("LIGHTING BARS", *top)
        for i in range(4):
            a, b = pts[i], pts[(i + 1) % 4]
            e += face("LIGHTING BARS", a, b, (b[0], b[1], b1[2]), (a[0], a[1], b1[2]))

    # --- Dimension lines: skipped by name, and here to prove that ------------------
    for y in (-14.5, 14.5):
        e += ["0", "LINE", "8", "DIMENSIONS",
              "10", "-12", "20", f"{y}", "30", "0",
              "11", "23", "21", f"{y}", "31", "0"]

    return e


def main(path):
    entities = build()
    doc = (
        ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
         "0", "SECTION", "2", "ENTITIES"]
        + entities
        + ["0", "ENDSEC", "0", "EOF"]
    )
    # Coordinates above are in metres for legibility; $INSUNITS says millimetres, so
    # scale on the way out. The tool then reads the units from the header rather than
    # guessing, which is the path worth demonstrating.
    out = []
    for i in range(0, len(doc), 2):
        code, value = doc[i], doc[i + 1]
        if code in ("10", "11", "12", "13", "20", "21", "22", "23", "30", "31", "32", "33"):
            value = f"{float(value) * MM:.1f}"
        out += [code, value]

    text = "\n".join(out) + "\n"
    Path(path).write_text(text)
    faces = sum(1 for i in range(0, len(doc), 2) if doc[i] == "0" and doc[i + 1] == "3DFACE")
    print(f"{path}  {faces} faces ({faces * 2} triangles), {len(text) // 1024} kB")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo-venue.dxf")
