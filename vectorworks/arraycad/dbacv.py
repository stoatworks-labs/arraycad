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
    def from_face(name, world_points, plane_type, order_index=1):
        # type: (str, Sequence[Vec3], int, int) -> Optional[RoomObject]
        """Build a quad or triangle from world-space points.

        Origin is the centroid and Rotation stays zero, with the points carried as
        offsets. ArrayCalc's own files do use non-zero Rotation, but it is not required:
        quads need not even be planar (the sample rakes seating by lifting two corners),
        so an axis-aligned local frame can express anything. Solving for a rotation the
        file does not need would only add a way to be subtly wrong.
        """
        pts = list(world_points)
        if len(pts) not in (3, 4):
            return None
        n = float(len(pts))
        cx = sum(p[0] for p in pts) / n
        cy = sum(p[1] for p in pts) / n
        cz = sum(p[2] for p in pts) / n
        return RoomObject(
            name,
            shape=SHAPE_TRIANGLE if len(pts) == 3 else SHAPE_QUAD,
            plane_type=plane_type,
            origin=(cx, cy, cz),
            points=[(p[0] - cx, p[1] - cy, p[2] - cz) for p in pts],
            order_index=order_index,
        )

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
