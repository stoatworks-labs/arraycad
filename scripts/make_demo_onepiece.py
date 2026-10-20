#!/usr/bin/env python3
"""Generate a synthetic theatre as ONE mesh, written as an OBJ.

    python3 scripts/make_demo_onepiece.py [out.obj]

The fixture for `src/lib/prepare/split.ts`, and for the two importer fixes that came with
it. Every other demo file is named layer by layer, which is the case `prepare/plan.ts`
was built for: it reads the names. This one has none to read. It is what a media server's
stock stage, a Blender export or an STL actually looks like — floor, stage, seating, walls
and ceiling all one object, called `Venue`.

What is in it, and what each part is there to test:

  * STALLS: a stepped FAN, 14 curved rows rising 0.15 m a row over a 0.9 m pitch, 80
    degrees wide. A cone, not a plane, so no one plane fits it: the splitter has to cut it
    into sectors, and each sector has to come back within a step's spread of its plane.
  * BALCONY: 8 straight stepped rows, 0.4 m a row, starting 4.5 m up and OVERHANGING the
    back of the stalls. Stacked in plan over the stalls, so only a cut across the fitted
    plane can separate the two, and a plane through both would sit in mid-air.
  * The balcony's front (1.1 m, too tall for a riser) and its soffit, a level surface
    with a room under it and the balcony right over it: a ceiling, not a floor.
  * STAGE: 1.0 m up, with a five-step stair to the floor. Five steps is too little tread
    to be seating, and the stage too deep to be a row.
  * The flat FLOOR is wound downwards, as exported floors often are, and is still a floor.
  * Walls and a ceiling at 12 m.
  * Y-UP, as Blender and most mesh packages write it, so the up-axis guess is exercised,
    and one stray `l` line, which used to make three's OBJ loader drop every face.

Metres. **Nothing here is a real venue.**
"""

import math
import sys
from pathlib import Path

verts = []
faces = []


def v(x, y, z):
    """A vertex given Z-UP (x, y in plan, z height), written Y-up: (x, z, -y)."""
    verts.append((x, z, -y))
    return len(verts)


def quad(a, b, c, d):
    """A quad as two triangles, a-b-c-d counter-clockwise seen from where it faces."""
    pa, pb, pc, pd = (v(*p) for p in (a, b, c, d))
    faces.append((pa, pb, pc))
    faces.append((pa, pc, pd))


def flipped(a, b, c, d):
    quad(d, c, b, a)


# --- Floor and stage --------------------------------------------------------------------
# The house runs along +Y from the stage. Plan 30 m wide (x -15..15), 34 m deep (y -8..26).
W0, W1 = -15.0, 15.0
D0, D1 = -8.0, 26.0
CEILING = 12.0

# Flat floor between the stage and the stalls, wound DOWNWARDS on purpose.
flipped((W0, 0.0, 0.0), (W1, 0.0, 0.0), (W1, 2.5, 0.0), (W0, 2.5, 0.0))

# Stage: level deck 1.0 m up, with its front.
STAGE = 1.0
quad((-8.0, D0, STAGE), (8.0, D0, STAGE), (8.0, 0.0, STAGE), (-8.0, 0.0, STAGE))
quad((-8.0, 0.0, 0.0), (8.0, 0.0, 0.0), (8.0, 0.0, STAGE), (-8.0, 0.0, STAGE))
# Floor either side of the stage.
quad((W0, D0, 0.0), (-8.0, D0, 0.0), (-8.0, 0.0, 0.0), (W0, 0.0, 0.0))
quad((8.0, D0, 0.0), (W1, D0, 0.0), (W1, 0.0, 0.0), (8.0, 0.0, 0.0))

# Five steps from the floor to stage level, beside the stage: 1.2 m wide, 0.3 m treads.
x0, x1 = 8.2, 9.4
for i in range(5):
    z = (i + 1) * STAGE / 5
    y = -0.3 * i
    quad((x0, y - 0.3, z), (x1, y - 0.3, z), (x1, y, z), (x0, y, z))
    quad((x0, y, z - STAGE / 5), (x1, y, z - STAGE / 5), (x1, y, z), (x0, y, z))

# --- Stalls: a stepped fan --------------------------------------------------------------
# Rows are arcs about a centre on the stage edge, 6 m to 18.6 m out, 80 degrees wide.
CENTRE = (0.0, -2.0)
R0, PITCH, RISE, ROWS = 6.0, 0.9, 0.15, 14
HALF = math.radians(40)
SEGS = 16


def arc(r, k):
    a = -HALF + 2 * HALF * k / SEGS
    return (CENTRE[0] + r * math.sin(a), CENTRE[1] + r * math.cos(a))


for row in range(ROWS):
    r_in = R0 + row * PITCH
    r_out = r_in + PITCH
    z = row * RISE
    for k in range(SEGS):
        a, b = arc(r_in, k), arc(r_in, k + 1)
        c, d = arc(r_out, k + 1), arc(r_out, k)
        # Tread.
        quad((a[0], a[1], z), (b[0], b[1], z), (c[0], c[1], z), (d[0], d[1], z))
        # Riser up to the next row, at its outer edge.
        if row < ROWS - 1:
            quad((d[0], d[1], z), (c[0], c[1], z), (c[0], c[1], z + RISE), (d[0], d[1], z + RISE))

# The cross-aisle behind the stalls, level with their top row: somewhere to stand, under
# the balcony.
REAR = ROWS * RISE
quad((W0, 16.6, REAR), (W1, 16.6, REAR), (W1, D1, REAR), (W0, D1, REAR))

# --- Balcony: a straight stepped rake over the back of the stalls -----------------------
B_Z0, B_RISE, B_ROWS, B_PITCH = 4.5, 0.4, 8, 0.9
BY0 = 15.0  # front edge, over the back rows of the stalls
BX0, BX1 = -6.0, 6.0
for row in range(B_ROWS):
    y0 = BY0 + row * B_PITCH
    y1 = y0 + B_PITCH
    z = B_Z0 + row * B_RISE
    quad((BX0, y0, z), (BX1, y0, z), (BX1, y1, z), (BX0, y1, z))
    if row < B_ROWS - 1:
        quad((BX0, y1, z), (BX1, y1, z), (BX1, y1, z + B_RISE), (BX0, y1, z + B_RISE))
# Its front, 1.1 m up from the soffit: far too tall for a riser.
SOFFIT = B_Z0 - 0.3
quad((BX1, BY0, SOFFIT), (BX0, BY0, SOFFIT), (BX0, BY0, SOFFIT + 1.1), (BX1, BY0, SOFFIT + 1.1))
# The soffit: level, facing down, with the stalls a room's height below it.
BY1 = BY0 + B_ROWS * B_PITCH
flipped((BX0, BY0, SOFFIT), (BX1, BY0, SOFFIT), (BX1, BY1, SOFFIT), (BX0, BY1, SOFFIT))

# --- Walls and ceiling ------------------------------------------------------------------
for a, b in (((W0, D0), (W1, D0)), ((W1, D0), (W1, D1)), ((W1, D1), (W0, D1)), ((W0, D1), (W0, D0))):
    quad((b[0], b[1], 0.0), (a[0], a[1], 0.0), (a[0], a[1], CEILING), (b[0], b[1], CEILING))
flipped((W0, D0, CEILING), (W1, D0, CEILING), (W1, D1, CEILING), (W0, D1, CEILING))

out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent.parent / "demo" / "demo-onepiece.obj")
with out.open("w") as f:
    f.write("# ArrayCAD demo: a synthetic theatre as one Y-up mesh. Not a real venue.\n")
    f.write("# Generated by scripts/make_demo_onepiece.py\n")
    f.write("o Venue\n")
    for p in verts:
        f.write(f"v {p[0]:.4f} {p[1]:.4f} {p[2]:.4f}\n")
    for t in faces:
        f.write(f"f {t[0]} {t[1]} {t[2]}\n")
    # A stray edge, as a Blender export leaves one: it used to cost every face above.
    f.write("l 1 2\n")
print(f"wrote {out}: {len(verts)} vertices, {len(faces)} triangles")
