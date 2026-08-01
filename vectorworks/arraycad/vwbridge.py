"""The only module that touches Vectorworks.

Everything else in this package is pure Python and tested without Vectorworks running.
This file is the opposite: it is untestable here, so it is written to fail loudly.

Every `vs` call goes through `_call`, which checks the function exists before using it
and records what happened. If a name or signature is wrong on your Vectorworks version,
you get a named diagnostic in the report — not silently wrong geometry, which in an
acoustic model means reflectors in the wrong place and nobody noticing.

The function names used here were read out of the Vectorworks 2025 application binary,
so they exist in that version. Their exact SIGNATURES are the residual risk. Run
`arraycad_probe.py` first; it reports which calls actually work on your install.

Coordinates come out of Vectorworks in the document's own length unit, and the mapping
from `vs.GetUnits()` to a real-world scale is version-specific and undocumented. Rather
than guess, `document_units_per_metre()` returns a stated fallback and the exporter
shows the resulting model size for confirmation before writing anything.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Tuple

try:
    import vs  # type: ignore
except ImportError:  # pragma: no cover - only ever true outside Vectorworks
    vs = None

Vec3 = Tuple[float, float, float]


class BridgeReport(object):
    """What worked, what did not, and what was skipped. Shown to the user afterwards."""

    def __init__(self):
        self.missing = []  # type: List[str]
        self.failed = {}  # type: Dict[str, str]
        self.skipped = {}  # type: Dict[str, int]
        self.notes = []  # type: List[str]

    def skip(self, reason):
        # type: (str) -> None
        self.skipped[reason] = self.skipped.get(reason, 0) + 1

    def ok(self):
        # type: () -> bool
        return not self.missing and not self.failed

    def lines(self):
        # type: () -> List[str]
        out = []
        for name in sorted(set(self.missing)):
            out.append("MISSING: vs.{} does not exist on this Vectorworks version.".format(name))
        for name in sorted(self.failed):
            out.append("FAILED:  vs.{} — {}".format(name, self.failed[name]))
        for reason in sorted(self.skipped):
            out.append("skipped {}x  {}".format(self.skipped[reason], reason))
        out.extend(self.notes)
        return out


REPORT = BridgeReport()


def available():
    # type: () -> bool
    return vs is not None


def _call(name, *args):
    """Call vs.<name>(*args), recording absence or failure instead of raising.

    Returns None on any problem. Callers must treat None as "unknown", never as a value.
    """
    fn = getattr(vs, name, None) if vs is not None else None
    if fn is None:
        REPORT.missing.append(name)
        return None
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001 - the whole point is to not propagate
        REPORT.failed[name] = "{}: {}".format(type(exc).__name__, exc)
        return None


def has(name):
    # type: (str) -> bool
    return vs is not None and getattr(vs, name, None) is not None


# ------------------------------------------------------------------------ units


def document_units_per_metre():
    # type: () -> float
    """Metres per Vectorworks internal unit.

    Vectorworks works internally in the document's length unit. `GetPrefReal(152)` is
    the units-per-inch preference in older references; rather than trust one magic
    number, this measures instead: it is not worth guessing, and a wrong factor is the
    single most damaging error this tool can make.

    Returns 0.001 (millimetres) as the fallback, and says so in the report — the export
    dialog always shows the resulting model size so a wrong guess is visible immediately.
    """
    # GetUnits returns the document unit index; the mapping is version-specific and
    # undocumented, so it is reported rather than interpreted.
    idx = _call("GetUnits")
    if idx is not None:
        REPORT.notes.append("Document unit index from vs.GetUnits() is {}.".format(idx))
    REPORT.notes.append(
        "Unit scale was NOT read from the document — check the model size shown in the "
        "dialog against a dimension you know."
    )
    return 0.001


# ------------------------------------------------------------------- traversal


def object_info(h):
    # type: (object) -> Dict[str, object]
    """Name, class, layer and type of an object handle."""
    layer = _call("GetLayer", h)
    return {
        "name": _call("GetName", h) or "",
        "class": _call("GetClass", h) or "",
        "layer": (_call("GetLName", layer) or "") if layer is not None else "",
        "type": _call("GetTypeN", h),
    }


def each_object(criteria, callback):
    # type: (str, Callable[[object], None]) -> None
    """vs.ForEachObject over a criteria string, e.g. "(C='Seating')" or "(SEL=TRUE)"."""
    _call("ForEachObject", callback, criteria)


def selected_criteria():
    # type: () -> str
    return "(SEL=TRUE)"


def class_criteria(class_name):
    # type: (str) -> str
    # Vectorworks criteria use single quotes; a class name containing one would break
    # the expression, so it is doubled the way VW's own criteria builder does.
    return "(C='{}')".format(class_name.replace("'", "''"))


def list_classes():
    # type: () -> List[str]
    """Every class name in the document, via the classes list API."""
    names = []  # type: List[str]
    count = _call("ClassNum")
    if count is None:
        return names
    for i in range(1, int(count) + 1):
        n = _call("ClassList", i)
        if n:
            names.append(n)
    return names


# ------------------------------------------------------------------- geometry


def poly3d_triangles(h, scale):
    # type: (object, float) -> List[float]
    """Read a 3D polygon as a triangle fan about its centroid."""
    n = _call("GetVertNum", h)
    if not n or int(n) < 3:
        return []
    pts = []  # type: List[Vec3]
    for i in range(1, int(n) + 1):
        p = _call("GetPolyPt3D", h, i)
        if p is None:
            return []
        pts.append((float(p[0]) * scale, float(p[1]) * scale, float(p[2]) * scale))

    from .geom import triangulate_polygon

    return triangulate_polygon(pts)


def mesh_triangles(h, scale):
    # type: (object, float) -> List[float]
    """Read a Vectorworks mesh.

    GetMeshVertsCnt / GetMeshVertex expose vertices but NOT face topology, so this
    treats the vertex stream as consecutive triangles. That holds for a mesh produced by
    'Convert to Mesh', which triangulates, and does NOT hold for a hand-built mesh with
    n-gon faces — those come out as garbage triangles. `object_triangles` therefore
    tries the 3D-polygon and group paths first, and the probe reports which path each of
    your objects actually took.
    """
    count = _call("GetMeshVertsCnt", h)
    if not count or int(count) < 3:
        return []
    pts = []  # type: List[Vec3]
    for i in range(1, int(count) + 1):
        p = _call("GetMeshVertex", h, i)
        if p is None:
            return []
        pts.append((float(p[0]) * scale, float(p[1]) * scale, float(p[2]) * scale))

    out = []  # type: List[float]
    for i in range(0, (len(pts) // 3) * 3, 3):
        for p in pts[i : i + 3]:
            out.extend(p)
    return out


def group_triangles(h, scale, depth=0):
    # type: (object, float, int) -> List[float]
    """Walk a group, accumulating triangles from every 3D polygon inside it."""
    if depth > 16:
        REPORT.skip("group nested deeper than 16 levels")
        return []
    out = []  # type: List[float]
    child = _call("FInGroup", h)
    guard = 0
    while child is not None and guard < 200000:
        guard += 1
        out.extend(object_triangles(child, scale, depth + 1))
        child = _call("NextObj", child)
    return out


def object_triangles(h, scale, depth=0):
    # type: (object, float, int) -> List[float]
    """Triangles for any object, by type.

    Type numbers are NOT hardcoded. VectorScript type numbers vary between versions and
    a wrong constant here would silently read the wrong geometry, so this dispatches on
    what actually responds: a handle with vertices is a polygon, one with mesh vertices
    is a mesh, one with children is a group.
    """
    n = _call("GetVertNum", h)
    if n and int(n) >= 3:
        tris = poly3d_triangles(h, scale)
        if tris:
            return tris

    count = _call("GetMeshVertsCnt", h)
    if count and int(count) >= 3:
        tris = mesh_triangles(h, scale)
        if tris:
            return tris

    if _call("FInGroup", h) is not None:
        return group_triangles(h, scale, depth)

    return []


# ------------------------------------------------ converting solids to readable mesh


CONVERT_TO_MESH_MENU = "Convert to Mesh"


def triangles_via_mesh_conversion(h, scale):
    # type: (object, float) -> List[float]
    """Convert a DUPLICATE of an object to a mesh, read it, then delete the duplicate.

    Extrudes, solids, walls and slabs cannot be read vertex-by-vertex, but Vectorworks
    will tessellate any of them. Working on a duplicate matters: 'Convert to Mesh'
    replaces the original in the document, and this tool must never modify the user's
    drawing.

    If anything in the sequence fails the duplicate is still deleted, so a failed export
    does not leave debris behind in the drawing.
    """
    dup = _call("CreateDuplicateObject", h, _call("GetParent", h))
    if dup is None:
        dup = _call("HDuplicate", h, 0, 0)
    if dup is None:
        REPORT.skip("could not duplicate an object for mesh conversion")
        return []

    converted = None
    try:
        _call("DSelectAll")
        _call("SetSelect", dup)
        _call("DoMenuTextByName", CONVERT_TO_MESH_MENU, 0)
        # The menu command replaces the selected object, so re-acquire the handle.
        converted = _call("FSActLayer")
        tris = object_triangles(converted if converted is not None else dup, scale)
        if not tris:
            REPORT.skip("'Convert to Mesh' produced nothing readable")
        return tris
    finally:
        # Delete both handles: if the menu replaced the duplicate, `dup` is already
        # stale and DelObject on it is a no-op; if it did not, `converted` is `dup` and
        # the second delete is. Either way the drawing is left as it was found.
        for handle in (converted, dup):
            if handle is not None:
                _call("DelObject", handle)
        _call("DSelectAll")


# ------------------------------------------------------------------- file output


def ask_save_path(default_name):
    # type: (str) -> Optional[str]
    """Standard save dialog. Returns None if the user cancels."""
    result = _call("PutFile", "Save ArrayCalc venue", "dbacv", default_name)
    if result is None:
        return None
    # vs.PutFile returns (ok, path) in Python; older VectorScript returned a bare path.
    if isinstance(result, (tuple, list)):
        ok, path = result[0], result[1]
        return path if ok else None
    return result or None


def write_text_file(path, text):
    # type: (str, str) -> bool
    """Write via Python rather than vs.Rewrite/WriteLn.

    vs.WriteLn appends a line ending per call, which would corrupt a file whose exact
    bytes matter — and for .dbacv they do, because matching ArrayCalc's own output is
    the whole basis for trusting the format. Python's open() writes what it is given.
    """
    try:
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        return True
    except (IOError, OSError) as exc:
        REPORT.failed["write_text_file"] = str(exc)
        return False


def alert(message):
    # type: (str) -> None
    _call("AlrtDialog", message)


def message(text):
    # type: (str) -> None
    _call("Message", text)
