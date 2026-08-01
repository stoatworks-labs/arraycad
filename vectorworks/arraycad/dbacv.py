"""Write d&b ArrayCalc venue files (.dbacv).

Pure Python 3.9 — Vectorworks 2025 bundles CPython 3.9, so no `match`, no PEP 604
unions at runtime, no `dataclass(slots=True)`.

This module imports nothing from Vectorworks and has no side effects, which is what
lets it be tested without Vectorworks running. `tests/test_dbacv.py` proves it by
reproducing a real ArrayCalc 12.8.2 export byte for byte, exactly as the TypeScript
writer does.

The format is undocumented; see ../../docs/dbacv-format.md for what is known and how.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- shapes

SHAPE_QUAD = 1
SHAPE_ARC = 2
SHAPE_BOX = 4
SHAPE_GROUP = 5
SHAPE_TRIANGLE = 6

# ⚠️ INFERRED from one sample file, not from d&b documentation. See the format doc.
PLANE_NONE = 0
PLANE_AUDIENCE = 1
PLANE_SURFACE = 2
PLANE_STAGE = 4
PLANE_SOUNDSCAPE = 5

PLANE_TYPE_NAMES = {
    PLANE_NONE: "None / group",
    PLANE_AUDIENCE: "Audience",
    PLANE_SURFACE: "Surface",
    3: "Type 3 (unknown)",
    PLANE_STAGE: "Stage",
    PLANE_SOUNDSCAPE: "Soundscape",
}

DEFAULT_LISTENER_HEIGHT = {
    PLANE_NONE: 1.2,
    PLANE_AUDIENCE: 1.2,
    PLANE_SURFACE: 0.01,
    3: 1.2,
    PLANE_STAGE: 0.01,
    PLANE_SOUNDSCAPE: 0.01,
}

# Sampled from the fixture so exports look native in ArrayCalc's own list.
PLANE_COLOURS = {
    PLANE_NONE: 0xFFFFFFFF,
    PLANE_AUDIENCE: 0xFFE8DCDA,
    PLANE_SURFACE: 0xFFA1E0AA,
    3: 0xFFCCCCCC,
    PLANE_STAGE: 0xFFC8B4E0,
    PLANE_SOUNDSCAPE: 0xFF00C0AE,
}

# Every object in the fixture carries this same PrintColor.
PRINT_COLOUR = 4294945280

Vec3 = Tuple[float, float, float]


# ---------------------------------------------------------------------- formatting


def g17(v: float) -> str:
    """Format a double the way C's printf("%.17g") does, which is what ArrayCalc uses.

    Precision P = 17. With base-10 exponent X: if -4 <= X < P the value is written
    fixed with P-1-X fraction digits, otherwise scientific with P-1. Trailing zeros in
    the fraction are then stripped, and a bare trailing point goes with them.

    This is why a real ArrayCalc file is full of values like 5.4050000000000002 — that
    is not a precision bug, it is the exact decimal of the double nearest 5.405.
    Reproducing it is what makes a diff against a genuine export meaningful.
    """
    if v != v:  # NaN
        return "nan"
    if math.isinf(v):
        return "inf" if v > 0 else "-inf"
    if v == 0.0:
        return "-0" if math.copysign(1.0, v) < 0 else "0"

    p = 17
    # The exponent must be the one from a %e conversion AT PRECISION P-1, which is what
    # C's %g uses. Python's default %e rounds to 6 decimals, and that rounding tips
    # 9.9999999999999978e-02 up to 1.000000e-01 — an exponent of -1 instead of -2, one
    # fraction digit too few, and 0.099999999999999978 comes out as 0.09999999999999998.
    exp = int("{:.{}e}".format(v, p - 1).split("e")[1])

    if -4 <= exp < p:
        s = "{:.{}f}".format(v, max(0, p - 1 - exp))
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return s

    s = "{:.{}e}".format(v, p - 1)
    mant, e = s.split("e")
    if "." in mant:
        mant = mant.rstrip("0").rstrip(".")
    # Python pads the exponent to two digits ("e-16", "e+05"); C's %g does not pad
    # beyond two either, but it drops the leading zero for three-digit exponents only.
    sign = "-" if e[0] == "-" else "+"
    digits = e[1:].lstrip("0") or "0"
    return "{}e{}{}".format(mant, sign, digits)


def _esc(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# -------------------------------------------------------------- the canonical quad


def canonical_quad(pts, tol=1e-4):
    # type: (Sequence[Vec3], float) -> Optional[Tuple[Vec3, float, List[Vec3]]]
    """Express four world points as an ArrayCalc Shape=1 quad, or return None.

    THIS IS A HARD FORMAT REQUIREMENT and getting it wrong is silent and destructive.
    An earlier version wrote quads with the origin at the centroid and points spread
    symmetrically around it — the obvious encoding, and one that round-trips perfectly
    through our own reader. ArrayCalc 12.8.2 imported those and collapsed every one to
    ZERO DEPTH: a 4 x 3 m plane became a 3 m line, with no error message.

    The real form, confirmed on all 26 quads in the reference venue and by a round trip
    through ArrayCalc itself:

        origin   at the MIDPOINT OF THE NEAR EDGE, not the centroid
        rotation about Z only
        P1 = (0,     +wNear/2, 0)      P2 = (depth, +wFar/2, rise)
        P4 = (0,     -wNear/2, 0)      P3 = (depth, -wFar/2, rise)

    so a quad is a SYMMETRIC TRAPEZOID: near and far edges both LEVEL and parallel, both
    bisected by the local X axis, the far edge free to sit at a different height. `rise`
    is where the tilt lives, and `depth` may be ZERO — that is precisely how ArrayCalc
    stores a vertical plane. Every rail front in the reference venue is depth 0.

    So horizontal, vertical and raked planes are all expressible. What is not is a
    sheared parallelogram, an asymmetric trapezoid, or a quad with no level edge at all.
    Returns None for those; use two triangles, which ArrayCalc accepts untouched.

    Returns (origin, rotation_z_degrees, [P1, P2, P3, P4]).
    """
    pts = list(pts)
    if len(pts) != 4:
        return None

    # The caller's winding is arbitrary; only some alignments match the convention.
    found = []
    for ring in (pts, list(reversed(pts))):
        for r in range(4):
            got = _try_canonical(
                ring[r], ring[(r + 1) % 4], ring[(r + 2) % 4], ring[(r + 3) % 4], tol
            )
            if got is not None:
                found.append(got)
    if not found:
        return None

    # Prefer a non-negative depth. Geometrically identical either way, but ArrayCalc
    # writes depth >= 0 on all 26 quads in the reference venue.
    for got in found:
        if got[2][1][0] >= -1e-9:
            return got
    return found[0]


def _try_canonical(p1, p2, p3, p4, tol):
    # type: (Vec3, Vec3, Vec3, Vec3, float) -> Optional[Tuple[Vec3, float, List[Vec3]]]
    eps = 1e-9
    # Both edges must be LEVEL. The frame rotates about Z only, so near and far edges are
    # always horizontal and the plane's tilt lives entirely in `rise`.
    if abs(p1[2] - p4[2]) > tol or abs(p2[2] - p3[2]) > tol:
        return None

    # The near edge sets local +Y; local +X is that turned -90 degrees.
    e0x, e0y = p1[0] - p4[0], p1[1] - p4[1]
    w_near = math.hypot(e0x, e0y)
    if w_near < eps:
        return None
    yx, yy = e0x / w_near, e0y / w_near
    xx, xy = yy, -yx

    # The far edge must be parallel to the near edge and point the same way.
    e1x, e1y = p2[0] - p3[0], p2[1] - p3[1]
    w_far = math.hypot(e1x, e1y)
    if w_far > eps:
        if abs(e1x * yy - e1y * yx) > tol:
            return None
        if e1x * yx + e1y * yy < 0:
            return None

    m0x, m0y = (p1[0] + p4[0]) / 2.0, (p1[1] + p4[1]) / 2.0
    m1x, m1y = (p2[0] + p3[0]) / 2.0, (p2[1] + p3[1]) / 2.0
    dx, dy = m1x - m0x, m1y - m0y

    # The far edge must sit square in front of the near one, or the quad is sheared.
    if abs(dx * yx + dy * yy) > tol:
        return None

    depth = dx * xx + dy * xy
    rise = p2[2] - p1[2]
    # Depth may be ZERO: that is exactly how ArrayCalc stores a vertical plane, and every
    # rail front in the reference venue is depth 0 with a negative rise.
    if abs(depth) < eps and abs(rise) < eps:
        return None

    return (
        (m0x, m0y, p1[2]),
        math.degrees(math.atan2(xy, xx)),
        [
            (0.0, w_near / 2.0, 0.0),
            (depth, w_far / 2.0, rise),
            (depth, -w_far / 2.0, rise),
            (0.0, -w_near / 2.0, 0.0),
        ],
    )


# -------------------------------------------------------------------------- model


class RoomObject(object):
    """One <RoomObject>.

    There is deliberately no `id` and no parent pointer: ParentVenueObjectId is the
    parent's 1-based depth-first document index and is recomputed on every write. That
    is what makes deleting an object safe — everything after it renumbers itself.
    """

    def __init__(
        self,
        name,
        shape=SHAPE_QUAD,
        plane_type=PLANE_AUDIENCE,
        points=None,
        origin=(0.0, 0.0, 0.0),
        rotation=(0.0, 0.0, 0.0),
        scaling=(1.0, 1.0, 1.0),
        listener_height=None,
        colour=None,
        order_index=0,
        enabled=True,
        locked=False,
        transparent=False,
        children=None,
        arc=None,
    ):
        # type: (str, int, int, Optional[Sequence[Vec3]], Vec3, Vec3, Vec3, Optional[float], Optional[int], int, bool, bool, Optional[List[RoomObject]], Optional[Dict[str, float]]) -> None
        self.name = name
        self.shape = shape
        self.plane_type = plane_type
        self.points = list(points or [])
        self.origin = origin
        self.rotation = rotation
        self.scaling = scaling
        self.listener_height = (
            DEFAULT_LISTENER_HEIGHT.get(plane_type, 1.2)
            if listener_height is None
            else listener_height
        )
        self.colour = PLANE_COLOURS.get(plane_type, 0xFFCCCCCC) if colour is None else colour
        self.order_index = order_index
        self.enabled = enabled
        self.locked = locked
        self.transparent = transparent
        self.children = list(children or [])
        self.arc = arc
        # Preserves a non-numeric ListenerHeight ("nan") verbatim on round trip.
        self.listener_height_raw = None  # type: Optional[str]

    @staticmethod
    def group(name, order_index=101, children=None, origin=(0.0, 0.0, 0.0)):
        # type: (str, int, Optional[List[RoomObject]], Vec3) -> RoomObject
        g = RoomObject(
            name,
            shape=SHAPE_GROUP,
            plane_type=PLANE_NONE,
            order_index=order_index,
            children=children,
            origin=origin,
        )
        g.colour = 0xFFFFFFFF
        return g

    @staticmethod
    def from_triangle(name, world_points, plane_type, order_index=1):
        # type: (str, Sequence[Vec3], int, int) -> Optional[RoomObject]
        """A triangle. ArrayCalc leaves a triangle's local frame entirely alone."""
        pts = list(world_points)
        if len(pts) != 3:
            return None
        cx = sum(p[0] for p in pts) / 3.0
        cy = sum(p[1] for p in pts) / 3.0
        cz = sum(p[2] for p in pts) / 3.0
        return RoomObject(
            name,
            shape=SHAPE_TRIANGLE,
            plane_type=plane_type,
            origin=(cx, cy, cz),
            points=[(p[0] - cx, p[1] - cy, p[2] - cz) for p in pts],
            order_index=order_index,
        )

    @staticmethod
    def from_face(name, world_points, plane_type, order_index=1):
        # type: (str, Sequence[Vec3], int, int) -> Optional[RoomObject]
        """A triangle, or a quad THAT FITS ArrayCalc's canonical frame. Else None.

        Returns None for a quad that cannot be expressed — see `canonical_quad`. Callers
        that can emit more than one object should use `faces_for` instead, which falls
        back to two triangles rather than dropping the geometry.
        """
        pts = list(world_points)
        if len(pts) == 3:
            return RoomObject.from_triangle(name, pts, plane_type, order_index)
        if len(pts) != 4:
            return None

        got = canonical_quad(pts)
        if got is None:
            return None
        origin, rotation_z, local = got
        return RoomObject(
            name,
            shape=SHAPE_QUAD,
            plane_type=plane_type,
            origin=origin,
            rotation=(0.0, 0.0, rotation_z),
            points=local,
            order_index=order_index,
        )

    @staticmethod
    def faces_for(name, world_points, plane_type, order_index=1):
        # type: (str, Sequence[Vec3], int, int) -> List[RoomObject]
        """One or two RoomObjects for a face, never dropping it.

        A quad that will not fit the canonical frame becomes two triangles. Two objects
        instead of one is the price of geometry that survives the import.
        """
        pts = list(world_points)
        if len(pts) == 3:
            o = RoomObject.from_triangle(name, pts, plane_type, order_index)
            return [o] if o else []
        if len(pts) != 4:
            return []

        one = RoomObject.from_face(name, pts, plane_type, order_index)
        if one is not None:
            return [one]

        out = []
        for suffix, tri in (
            ("a", [pts[0], pts[1], pts[2]]),
            ("b", [pts[0], pts[2], pts[3]]),
        ):
            o = RoomObject.from_triangle(
                name + suffix, tri, plane_type, order_index + (1 if suffix == "b" else 0)
            )
            if o:
                out.append(o)
        return out

    @staticmethod
    def from_box(name, bottom, top, plane_type, order_index=1):
        # type: (str, Sequence[Vec3], Sequence[Vec3], int, int) -> Optional[RoomObject]
        """Shape=4: bottom quad P1..P4 then top quad P5..P8.

        Worth using wherever the source object really is a box — a lighting bridge, a
        proscenium leg, a riser. One RoomObject instead of six, and it is what a person
        would have drawn in ArrayCalc by hand.
        """
        pts = list(bottom) + list(top)
        if len(pts) != 8:
            return None
        cx = sum(p[0] for p in pts) / 8.0
        cy = sum(p[1] for p in pts) / 8.0
        cz = sum(p[2] for p in pts) / 8.0
        return RoomObject(
            name,
            shape=SHAPE_BOX,
            plane_type=plane_type,
            origin=(cx, cy, cz),
            points=[(p[0] - cx, p[1] - cy, p[2] - cz) for p in pts],
            order_index=order_index,
        )


class VenueFile(object):
    def __init__(
        self,
        objects=None,
        project_name="Untitled",
        author="ArrayCAD",
        date=None,
        app_version="12.8.2",
        venue_version="9",
        project_comments="",
        venue_comments="",
    ):
        self.objects = list(objects or [])
        self.project_name = project_name
        self.author = author
        self.date = date or _today()
        self.app_version = app_version
        self.venue_version = venue_version
        self.project_comments = project_comments
        self.venue_comments = venue_comments


def _today():
    # type: () -> str
    """DD.MM.YYYY, the format ArrayCalc writes into <Date>."""
    import datetime

    d = datetime.date.today()
    return "{:02d}.{:02d}.{}".format(d.day, d.month, d.year)


# -------------------------------------------------------------------------- writer

_ARC_KEYS = (
    ("InnerRadiusA", "inner_radius_a"),
    ("InnerRadiusB", "inner_radius_b"),
    ("InnerZ", "inner_z"),
    ("OuterRadiusA", "outer_radius_a"),
    ("OuterRadiusB", "outer_radius_b"),
    ("OuterZ", "outer_z"),
    ("SpanAngle", "span_angle"),
    ("StartAngle", "start_angle"),
)


def _vec_tag(name, v, indent):
    # type: (str, Vec3, str) -> str
    return '{}<{} x="{}" y="{}" z="{}"/>\n'.format(indent, name, g17(v[0]), g17(v[1]), g17(v[2]))


def _write_object(o, parent_index, counter, depth, out):
    # type: (RoomObject, int, List[int], int, List[str]) -> None
    counter[0] += 1
    my_index = counter[0]
    pad = " " * (4 * depth)
    inner = " " * (4 * (depth + 1))
    is_group = o.shape == SHAPE_GROUP

    attrs = {
        "Color": str(o.colour & 0xFFFFFFFF),
        "Enabled": "1" if o.enabled else "0",
        "ListenerHeight": o.listener_height_raw
        if o.listener_height_raw is not None
        else g17(o.listener_height),
        "Locked": "1" if o.locked else "0",
        "Name": o.name,
        "OrderIndex": str(o.order_index),
        "ParentVenueObjectId": str(parent_index),
        "PlaneType": str(o.plane_type),
        "PrintColor": str(PRINT_COLOUR),
        "Shape": str(o.shape),
        "Transparent": "1" if o.transparent else "0",
    }
    if is_group:
        # Only groups carry this, and it is the string "true", not "1".
        attrs["ObjectGroup"] = "true"
    if o.arc and o.shape == SHAPE_ARC:
        for xml_key, py_key in _ARC_KEYS:
            attrs[xml_key] = g17(float(o.arc[py_key]))

    # Alphabetical, which is what ArrayCalc emits.
    rendered = "".join(
        ' {}="{}"'.format(k, _esc(attrs[k])) for k in sorted(attrs.keys())
    )
    out.append("{}<RoomObject{}>\n".format(pad, rendered))

    if is_group:
        # A group writes its children FIRST and its own transform last. That ordering is
        # not cosmetic, and the transform is real: child origins are relative to it.
        for c in o.children:
            _write_object(c, my_index, counter, depth + 1, out)
        out.append(_vec_tag("Origin", o.origin, inner))
        out.append(_vec_tag("Rotation", o.rotation, inner))
        out.append(_vec_tag("Scaling", o.scaling, inner))
    else:
        out.append(_vec_tag("Origin", o.origin, inner))
        out.append(_vec_tag("Rotation", o.rotation, inner))
        out.append(_vec_tag("Scaling", o.scaling, inner))
        for i, p in enumerate(o.points):
            out.append(_vec_tag("P{}".format(i + 1), p, inner))
        for c in o.children:
            _write_object(c, my_index, counter, depth + 1, out)

    out.append("{}</RoomObject>\n".format(pad))


def write_dbacv(venue):
    # type: (VenueFile) -> str
    out = ["<!DOCTYPE ArrayCalc>\n"]
    out.append('<ArrayCalc Version="{}">\n'.format(_esc(venue.app_version)))
    out.append('    <Project Name="{}">\n'.format(_esc(venue.project_name)))
    out.append("        <Date>{}</Date>\n".format(_esc(venue.date)))
    out.append("        <Author>{}</Author>\n".format(_esc(venue.author)))
    out.append("        <Comments>{}</Comments>\n".format(_esc(venue.project_comments)))
    out.append("    </Project>\n")
    out.append('    <Venue Version="{}">\n'.format(_esc(venue.venue_version)))
    out.append("        <Comments>{}</Comments>\n".format(_esc(venue.venue_comments)))

    counter = [0]
    for o in venue.objects:
        _write_object(o, 0, counter, 2, out)

    out.append("    </Venue>\n")
    out.append("</ArrayCalc>\n")
    return "".join(out)


# -------------------------------------------------------------------------- reader

def parse_dbacv(xml_text):
    # type: (str) -> VenueFile
    """Parse a .dbacv. Only needed so the writer can be proved by round trip."""
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_text)
    if root.tag != "ArrayCalc":
        raise ValueError("Expected an <ArrayCalc> root element, found <{}>".format(root.tag))

    project = root.find("Project")
    venue_el = root.find("Venue")
    if venue_el is None:
        raise ValueError("No <Venue> element — this file has no venue geometry")

    def text_of(parent, tag):
        if parent is None:
            return ""
        el = parent.find(tag)
        return (el.text or "") if el is not None else ""

    def vec(el, tag, default):
        child = el.find(tag)
        if child is None:
            return default
        return (
            float(child.get("x", 0)),
            float(child.get("y", 0)),
            float(child.get("z", 0)),
        )

    def read(el):
        # type: (ET.Element) -> RoomObject
        shape = int(el.get("Shape", SHAPE_QUAD))

        points = []
        for i in range(1, 9):
            p = el.find("P{}".format(i))
            if p is None:
                break
            points.append((float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))))

        arc = None
        if all(el.get(k) is not None for k, _ in _ARC_KEYS):
            arc = dict((py, float(el.get(xml))) for xml, py in _ARC_KEYS)

        lh_raw = el.get("ListenerHeight")
        try:
            lh = float(lh_raw) if lh_raw is not None else 1.2
            if lh != lh or math.isinf(lh):
                raise ValueError
            keep_raw = None
        except (TypeError, ValueError):
            # ArrayCalc writes a bare `nan` here on some groups. Keep the literal so a
            # round trip stays byte-exact, without letting NaN into the number.
            lh = 1.2
            keep_raw = lh_raw

        o = RoomObject(
            el.get("Name", "Unnamed"),
            shape=shape,
            plane_type=int(el.get("PlaneType", PLANE_AUDIENCE)),
            points=points,
            origin=vec(el, "Origin", (0.0, 0.0, 0.0)),
            rotation=vec(el, "Rotation", (0.0, 0.0, 0.0)),
            scaling=vec(el, "Scaling", (1.0, 1.0, 1.0)),
            listener_height=lh,
            colour=int(el.get("Color", 0xFF888888)),
            order_index=int(el.get("OrderIndex", 0)),
            enabled=el.get("Enabled", "1") in ("1", "true"),
            locked=el.get("Locked", "0") in ("1", "true"),
            transparent=el.get("Transparent", "0") in ("1", "true"),
            children=[read(c) for c in el.findall("RoomObject")],
            arc=arc,
        )
        o.listener_height_raw = keep_raw
        return o

    return VenueFile(
        objects=[read(c) for c in venue_el.findall("RoomObject")],
        project_name=project.get("Name", "Untitled") if project is not None else "Untitled",
        author=text_of(project, "Author"),
        date=text_of(project, "Date"),
        app_version=root.get("Version", "12.8.2"),
        venue_version=venue_el.get("Version", "9"),
        project_comments=text_of(project, "Comments"),
        venue_comments=text_of(venue_el, "Comments"),
    )
