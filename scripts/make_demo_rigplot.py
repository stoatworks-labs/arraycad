#!/usr/bin/env python3
"""Generate a synthetic ballroom RIG PLOT as a flat 2D DXF.

    python3 scripts/make_demo_rigplot.py [out.dxf]

The fixture for tracing a CAD plan (src/lib/trace/cad.ts). A rig plot is a 2D drawing in
a 3D format: every architectural line at z = 0, millimetres declared in the header, and
the production drawn over the top. Converted as a model it comes out as surfaces lying on
the floor — the ceiling coffers included. It belongs in the tracer, and this is the file
that proves it gets there at the right scale.

What is in it, and why each part is there:

  * WALLS, as loose LINEs, inner and outer face 0.2 m apart. The room is the inner face:
    x 40..70, y 120..140 (metres). Off the origin on purpose — a real plan sits on a site
    datum — so the test proves venue coordinates ARE drawing coordinates.
  * STAGE, a closed polyline the full width of the room, 6 m deep, so the audience floor
    the wand finds is exactly 24 x 20 m: x 46..70, y 120..140.
  * Ceiling Coffers, six closed rectangles over the audience. The Amfar case: a ceiling
    drawn in plan. Islands inside the floor, so the wand's default leaves them out.
  * CENTRELINE, one line straight across the room at y = 130. Clutter by name. Drawn on
    the sheet it would cut the audience floor in half; left off, the wand gets all of it.
  * BAR COUNTER, an open polyline: a layer with lines and no surface, so no node — still
    drawn, because it is not clutter.
  * TRUSS, a box truss as 3DFACEs at 7.0-7.4 m. Clutter, and the only thing with real
    height. Flat-plan detection must look past it.
  * CAD-Audio, two loudspeaker symbols drawn as 3D boxes 1.2 m tall. NOT clutter by name,
    exactly as on the real plot this was built against — detection must call the drawing
    flat anyway, because their area is nothing next to the plan's.
  * LX: fixture symbols as circles. Clutter.
  * TITLE BLOCK and a stray line on layer 0 at the origin, forty metres from the room. The
    first is clutter; the second is not, and the sheet must leave it off anyway.
  * A TEXT label, which the importer ignores.

**Nothing here is a real venue.** Every number is written down above, which is what makes
the tests assertions rather than observations.
"""

import sys
from pathlib import Path

MM = 1000.0


def line(layer, a, b):
    return ["0", "LINE", "8", layer,
            "10", a[0], "20", a[1], "30", 0.0,
            "11", b[0], "21", b[1], "31", 0.0]


def lwpoly(layer, pts, closed=True):
    out = ["0", "LWPOLYLINE", "8", layer, "90", str(len(pts)), "70", "1" if closed else "0"]
    for x, y in pts:
        out += ["10", x, "20", y]
    return out


def circle(layer, c, r):
    return ["0", "CIRCLE", "8", layer, "10", c[0], "20", c[1], "30", 0.0, "40", r]


def face(layer, a, b, c, d):
    out = ["0", "3DFACE", "8", layer]
    for i, p in enumerate((a, b, c, d)):
        out += [str(10 + i), p[0], str(20 + i), p[1], str(30 + i), p[2]]
    return out


def box(layer, x0, y0, z0, x1, y1, z1):
    """Six faces. A symbol modelled in 3D, the way rig plots draw loudspeakers and truss."""
    c = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    out = face(layer, *[(x, y, z1) for x, y in c])
    out += face(layer, *[(x, y, z0) for x, y in reversed(c)])
    for i in range(4):
        (ax, ay), (bx, by) = c[i], c[(i + 1) % 4]
        out += face(layer, (ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1))
    return out


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def build():
    e = []

    # Walls: inner and outer faces as separate LINEs, the way an architect draws them.
    for x0, y0, x1, y1 in ((40.0, 120.0, 70.0, 140.0), (39.8, 119.8, 70.2, 140.2)):
        c = rect(x0, y0, x1, y1)
        for i in range(4):
            e += line("WALLS", c[i], c[(i + 1) % 4])

    e += lwpoly("STAGE", rect(40.0, 120.0, 46.0, 140.0))

    for x in (50.0, 57.0, 64.0):
        for y in (122.5, 131.5):
            e += lwpoly("Ceiling Coffers", rect(x, y, x + 4.0, y + 6.0))

    e += line("CENTRELINE", (38.0, 130.0), (72.0, 130.0))

    e += lwpoly("BAR COUNTER", [(66.0, 136.0), (68.5, 136.0), (68.5, 138.0), (66.0, 138.0)], closed=False)

    # A 16 m box truss over the audience at 7 m, 0.4 m square.
    e += box("TRUSS", 58.0, 122.0, 7.0, 58.4, 138.0, 7.4)

    # Loudspeakers at the stage edge, drawn as 3D boxes on a layer the vocabulary does not know.
    for y in (121.0, 138.4):
        e += box("CAD-Audio", 45.0, y, 0.0, 45.6, y + 0.6, 1.2)

    for x in (52.0, 59.0, 66.0):
        e += circle("LX", (x, 121.0), 0.25)

    e += lwpoly("TITLE BLOCK", rect(0.0, 0.0, 0.42, 0.297))
    e += line("0", (0.0, 0.0), (0.4, 0.0))

    e += ["0", "TEXT", "8", "TEXT", "10", 55.0, "20", 129.0, "30", 0.0, "40", 0.5, "1", "BALLROOM"]
    return e


COORD_CODES = {"10", "11", "12", "13", "20", "21", "22", "23", "30", "31", "32", "33", "40"}


def main(path):
    doc = (
        ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
         "0", "SECTION", "2", "ENTITIES"]
        + build()
        + ["0", "ENDSEC", "0", "EOF"]
    )
    # Coordinates above are in metres for legibility; $INSUNITS says millimetres, so scale
    # on the way out and let the importer read the header rather than guess.
    out = []
    for i in range(0, len(doc), 2):
        code, value = doc[i], doc[i + 1]
        if code in COORD_CODES:
            value = f"{float(value) * MM:.1f}"
        out += [code, str(value)]

    Path(path).write_text("\n".join(out) + "\n")
    entities = sum(1 for i in range(0, len(doc), 2) if doc[i] == "0" and doc[i + 1] not in ("SECTION", "ENDSEC", "EOF"))
    print(f"{path}: {entities} entities")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo/demo-rigplot.dxf")
