#!/usr/bin/env python3
"""Generate diagnostic .dbacv files to open in ArrayCalc.

The point is a round trip: open these in ArrayCalc, look at them, save, and export.
Comparing the export against what went in answers the questions that cannot be answered
by reading one sample file — above all what the PlaneType codes actually mean, and
whether group transforms compose the way this project assumes.

Two files, deliberately:

  A — SAFE. Every construct in it was observed in the real ArrayCalc 12.8.2 export in
      test/fixtures/theatre.dbacv. It should open without complaint. If it does not,
      something basic about the writer is wrong.

  B — ADVENTUROUS. PlaneType codes never seen, group rotation and scaling that the
      sample never exercises. This one might be rejected — and that is itself an answer.
      Splitting them means a failure in B still leaves A's answers intact.

Every object's NAME states what it is testing and where it should be, so the file can be
checked by looking at it in ArrayCalc rather than by measuring.

    python3 scripts/make_probe_venue.py [output_dir]
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vectorworks"))

from arraycad.dbacv import (  # noqa: E402
    PLANE_AUDIENCE,
    PLANE_SOUNDSCAPE,
    PLANE_STAGE,
    PLANE_SURFACE,
    SHAPE_ARC,
    RoomObject,
    VenueFile,
    write_dbacv,
)


def quad(name, x0, y0, x1, y1, z=0.0, plane_type=PLANE_AUDIENCE, rake=0.0, order=1):
    """An axis-aligned quad. `rake` lifts the two far-X corners, as ArrayCalc rakes seating."""
    pts = [
        (x0, y0, z),
        (x1, y0, z + rake),
        (x1, y1, z + rake),
        (x0, y1, z),
    ]
    return RoomObject.from_face(name, pts, plane_type, order)


def box(name, x0, y0, z0, x1, y1, z1, plane_type=PLANE_SURFACE, order=1):
    bottom = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]
    top = [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    return RoomObject.from_box(name, bottom, top, plane_type, order)


def build_a():
    """Only constructs observed in the real ArrayCalc export."""
    objects = []
    n = [0]

    def add(o):
        n[0] += 1
        o.order_index = n[0]
        objects.append(o)
        return o

    # --- Shapes -------------------------------------------------------------
    # Column x 0..4. Each row 4 m apart in y so a displaced object is obvious.
    add(quad("A01 QUAD flat 4x3 at y16..19 z0", 0, 16, 4, 19, 0.0))
    add(quad("A02 QUAD raked +0.6z at far X, y12..15", 0, 12, 4, 15, 0.0, rake=0.6))
    add(
        RoomObject.from_face(
            "A03 TRI 4x3 at y8..11 z0",
            [(0.0, 8.0, 0.0), (4.0, 8.0, 0.0), (0.0, 11.0, 0.0)],
            PLANE_AUDIENCE,
        )
    )
    add(box("A04 BOX 4x3x1.5 at y4..7 z0..1.5", 0, 4, 0, 4, 7, 1.5))

    # Arc: a circular annulus sector, deliberately round numbers. Inner radius 10,
    # outer 14, sweeping 0-45 degrees, rising 1 m outward. If it lands as a flat ring
    # then InnerZ/OuterZ do not rake it after all.
    arc = RoomObject(
        "A05 ARC r10-14 sweep0-45 rise0-1 at origin(0,0,0)",
        shape=SHAPE_ARC,
        plane_type=PLANE_AUDIENCE,
        origin=(0.0, 0.0, 0.0),
        arc={
            "inner_radius_a": 10.0,
            "inner_radius_b": 10.0,
            "outer_radius_a": 14.0,
            "outer_radius_b": 14.0,
            "inner_z": 0.0,
            "outer_z": 1.0,
            "start_angle": 0.0,
            "span_angle": 45.0,
        },
    )
    add(arc)

    # --- Object rotation (observed: the sample has Shape=1 with Rotation z=-90) ------
    rot = quad("A06 QUAD rot z45 - should point NE in plan", 0, 0, 6, 0.5, 0.0)
    rot.origin = (10.0, 16.0, 0.0)
    rot.points = [(0.0, -0.25, 0.0), (6.0, -0.25, 0.0), (6.0, 0.25, 0.0), (0.0, 0.25, 0.0)]
    rot.rotation = (0.0, 0.0, 45.0)
    add(rot)

    # --- PlaneType probe ----------------------------------------------------
    # Identical geometry, only PlaneType differs. Whatever ArrayCalc calls these in its
    # own UI is the answer this whole project is missing.
    for i, (code, label) in enumerate(
        [
            (PLANE_AUDIENCE, "PT1"),
            (PLANE_SURFACE, "PT2"),
            (PLANE_STAGE, "PT4"),
            (PLANE_SOUNDSCAPE, "PT5"),
        ]
    ):
        y = 12 - i * 4
        add(quad("A1{} {} - what does ArrayCalc call this".format(i, label), 8, y, 12, y + 3, 0.0, code))

    # --- ListenerHeight: independent, or derived from PlaneType? ------------
    lh1 = quad("A20 PT1 with ListenerHeight 0.77 - kept or reset to 1.2", 16, 16, 20, 19, 0.0, PLANE_AUDIENCE)
    lh1.listener_height = 0.77
    add(lh1)

    lh2 = quad("A21 PT2 with ListenerHeight 1.55 - kept or reset to 0.01", 16, 12, 20, 15, 0.0, PLANE_SURFACE)
    lh2.listener_height = 1.55
    add(lh2)

    # --- Number formatting --------------------------------------------------
    # A coordinate that needs all 17 significant digits. If it comes back changed, the
    # writer's %.17g is not what ArrayCalc reads or writes.
    num = quad("A22 QUAD x1=4.0000000000000009 - check the digits survive", 16, 8, 20, 11, 0.0)
    num.points[1] = (num.points[1][0] + 4.0000000000000009 - 4.0, num.points[1][1], num.points[1][2])
    add(num)

    # --- Group with a translation (observed: every group in the sample) ------
    # Children are at LOCAL (0,0,*). If group origin composes they appear at y = -8ish.
    # If it is ignored they pile up at the venue origin.
    g_children = [
        RoomObject.from_face(
            "A30a child local(0,0) - should sit at world (2,-8)",
            [(0.0, -1.5, 0.0), (4.0, -1.5, 0.0), (4.0, 1.5, 0.0), (0.0, 1.5, 0.0)],
            PLANE_AUDIENCE,
            31,
        ),
        RoomObject.from_face(
            "A30b child local(0,-4) - should sit at world (2,-12)",
            [(0.0, -5.5, 0.0), (4.0, -5.5, 0.0), (4.0, -2.5, 0.0), (0.0, -2.5, 0.0)],
            PLANE_AUDIENCE,
            32,
        ),
    ]
    grp = RoomObject.group("A30 GROUP origin(0,-8,0) - do children move with it", 101, g_children)
    grp.origin = (0.0, -8.0, 0.0)
    n[0] += 1
    objects.append(grp)

    return objects


def build_b():
    """Constructs the sample never showed. This file may be rejected — that is data."""
    objects = []
    n = [0]

    def add(o):
        n[0] += 1
        o.order_index = n[0]
        objects.append(o)
        return o

    # --- The unknown PlaneTypes ---------------------------------------------
    add(quad("B01 PlaneType 0 on a real object - accepted", 0, 16, 4, 19, 0.0, 0))
    add(quad("B02 PlaneType 3 - NEVER SEEN, what is it", 0, 12, 4, 15, 0.0, 3))

    # --- Group rotation: THE untested inference ------------------------------
    # A 6 m bar. If group rotation composes onto children it points NE in plan; if the
    # group transform is ignored it points due +X. Unmistakable either way.
    bar = RoomObject(
        "B10a bar local +X - points NE if group rot composes",
        plane_type=PLANE_SURFACE,
        origin=(0.0, 0.0, 0.0),
        points=[(0.0, -0.25, 0.0), (6.0, -0.25, 0.0), (6.0, 0.25, 0.0), (0.0, 0.25, 0.0)],
        order_index=11,
    )
    marker = RoomObject(
        "B10b marker at local(6,0) - lands NE too if origins rotate",
        plane_type=PLANE_STAGE,
        origin=(6.0, 0.0, 0.0),
        points=[(-0.5, -0.5, 0.0), (0.5, -0.5, 0.0), (0.5, 0.5, 0.0), (-0.5, 0.5, 0.0)],
        order_index=12,
    )
    g_rot = RoomObject.group("B10 GROUP rot z45 at (10,8,0)", 101, [bar, marker])
    g_rot.origin = (10.0, 8.0, 0.0)
    g_rot.rotation = (0.0, 0.0, 45.0)
    n[0] += 1
    objects.append(g_rot)

    # --- Group scaling -------------------------------------------------------
    small = RoomObject(
        "B20a 2x2 square - becomes 4x4 if group scale 2 composes",
        plane_type=PLANE_AUDIENCE,
        origin=(0.0, 0.0, 0.0),
        points=[(-1.0, -1.0, 0.0), (1.0, -1.0, 0.0), (1.0, 1.0, 0.0), (-1.0, 1.0, 0.0)],
        order_index=21,
    )
    ref = RoomObject(
        "B20b 2x2 reference, same group",
        plane_type=PLANE_SURFACE,
        origin=(6.0, 0.0, 0.0),
        points=[(-1.0, -1.0, 0.0), (1.0, -1.0, 0.0), (1.0, 1.0, 0.0), (-1.0, 1.0, 0.0)],
        order_index=22,
    )
    g_scale = RoomObject.group("B20 GROUP scaling 2x at (10,-4,0)", 102, [small, ref])
    g_scale.origin = (10.0, -4.0, 0.0)
    g_scale.scaling = (2.0, 2.0, 2.0)
    n[0] += 1
    objects.append(g_scale)

    # --- Nested groups -------------------------------------------------------
    inner_child = RoomObject.from_face(
        "B30a inner child - two levels of translation should stack",
        [(-1.5, -1.5, 0.0), (1.5, -1.5, 0.0), (1.5, 1.5, 0.0), (-1.5, 1.5, 0.0)],
        PLANE_AUDIENCE,
        31,
    )
    inner = RoomObject.group("B30-inner GROUP origin(0,-4,0)", 103, [inner_child])
    inner.origin = (0.0, -4.0, 0.0)
    # A group of one is unusual; the sample never has one. Worth knowing if it survives.
    outer = RoomObject.group("B30 GROUP origin(10,-12,0) containing a group", 104, [inner])
    outer.origin = (10.0, -12.0, 0.0)
    n[0] += 1
    objects.append(outer)

    # --- Non-planar quad taken further --------------------------------------
    # The sample rakes by 0.4 m. This one warps all four corners to different heights,
    # which is geometrically not a plane at all.
    warp = RoomObject(
        "B40 QUAD fully warped, no two corners level",
        plane_type=PLANE_AUDIENCE,
        origin=(20.0, 8.0, 0.0),
        points=[(0.0, 0.0, 0.0), (4.0, 0.0, 0.5), (4.0, 3.0, 1.5), (0.0, 3.0, 0.4)],
        order_index=41,
    )
    add(warp)

    return objects


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Desktop")
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)

    files = [
        (
            "arraycad-probe-A.dbacv",
            VenueFile(
                objects=build_a(),
                project_name="ArrayCAD probe A (safe)",
                author="ArrayCAD",
                venue_comments="Diagnostic. Only constructs observed in a real ArrayCalc export.",
            ),
        ),
        (
            "arraycad-probe-B.dbacv",
            VenueFile(
                objects=build_b(),
                project_name="ArrayCAD probe B (adventurous)",
                author="ArrayCAD",
                venue_comments="Diagnostic. Untested constructs: PlaneType 0/3, group rotation and scaling, nesting.",
            ),
        ),
    ]

    for name, venue in files:
        path = os.path.join(out_dir, name)
        xml = write_dbacv(venue)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(xml)
        count = xml.count("<RoomObject")
        print("{}  {} objects, {} bytes".format(path, count, len(xml)))


if __name__ == "__main__":
    main()
