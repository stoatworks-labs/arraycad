"""Triangle soup -> ArrayCalc planes.

A deliberate second implementation of the core of ../../src/lib/geom/. The plug-in runs
inside Vectorworks' CPython 3.9 and cannot call the TypeScript, so the reduction has to
exist twice. To stop the two drifting, `tests/test_geom.py` uses the SAME synthetic
cases as `src/lib/geom/geom.test.ts` — a box is six regions, a split rectangle is one,
a 36-facet cylinder is not one.

This port is smaller than the TypeScript on purpose. It leaves out earcut and the greedy
quad merge, and adds two things the browser tool has no way to know:

  * `top_face` — for an audience plane or a stage deck, the answer is nearly always the
    largest upward-facing surface, not every face of the solid.
  * `as_box` — a Vectorworks extrude that really is a box maps onto ArrayCalc's Shape=4
    directly: one RoomObject instead of six, which is what a person would have drawn.

Nothing here imports `vs`, so it is testable without Vectorworks.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

Vec3 = Tuple[float, float, float]
Pt2 = Tuple[float, float]

# Metres. Matches DEFAULT_PLANARIZE in the TypeScript.
DEFAULT_WELD = 0.001
DEFAULT_ANGLE_DEG = 5.0
DEFAULT_OFFSET = 0.02
DEFAULT_MIN_AREA = 0.05
DEFAULT_SIMPLIFY = 0.05


# ---------------------------------------------------------------------- vectors


def sub(a, b):
    # type: (Vec3, Vec3) -> Vec3
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    # type: (Vec3, Vec3) -> Vec3
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def dot(a, b):
    # type: (Vec3, Vec3) -> float
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def length(a):
    # type: (Vec3) -> float
    return math.sqrt(dot(a, a))


def normalize(a):
    # type: (Vec3) -> Vec3
    l = length(a)
    return (a[0] / l, a[1] / l, a[2] / l) if l > 0 else (0.0, 0.0, 0.0)


def tri_area(a, b, c):
    # type: (Vec3, Vec3, Vec3) -> float
    return 0.5 * length(cross(sub(b, a), sub(c, a)))


class Mesh(object):
    def __init__(self, vertices, indices):
        # type: (List[Vec3], List[int]) -> None
        self.vertices = vertices
        self.indices = indices


class Region(object):
    def __init__(self, indices, normal, point, area):
        # type: (List[int], Vec3, Vec3, float) -> None
        self.indices = indices
        self.normal = normal
        self.point = point
        self.area = area


# ------------------------------------------------------------------------ weld


def weld(triangles, tol=DEFAULT_WELD):
    # type: (Sequence[float], float) -> Mesh
    """Fuse coincident vertices onto a grid of `tol`.

    Probes the 8 neighbouring cells as well as the home cell. Two vertices 0.1 mm apart
    still land in different cells whenever they straddle a cell boundary, and a pure
    quantise-and-hash weld then leaves exactly the hairline cracks it was meant to
    close — cracks that later split one ceiling into forty regions.
    """
    vertices = []  # type: List[Vec3]
    indices = []  # type: List[int]
    grid = {}  # type: Dict[Tuple[int, int, int], List[int]]
    inv = 1.0 / max(tol, 1e-9)

    def put(x, y, z):
        gi = int(round(x * inv))
        gj = int(round(y * inv))
        gk = int(round(z * inv))
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for dk in (-1, 0, 1):
                    for vi in grid.get((gi + di, gj + dj, gk + dk), ()):
                        v = vertices[vi]
                        if abs(v[0] - x) <= tol and abs(v[1] - y) <= tol and abs(v[2] - z) <= tol:
                            return vi
        idx = len(vertices)
        vertices.append((x, y, z))
        grid.setdefault((gi, gj, gk), []).append(idx)
        return idx

    n = (len(triangles) // 9) * 9
    for i in range(0, n, 9):
        a = put(triangles[i], triangles[i + 1], triangles[i + 2])
        b = put(triangles[i + 3], triangles[i + 4], triangles[i + 5])
        c = put(triangles[i + 6], triangles[i + 7], triangles[i + 8])
        # A triangle whose corners welded together has no area and no normal. Drop it
        # here, or it poisons the region normal it gets flood-filled into.
        if a == b or b == c or a == c:
            continue
        indices.extend((a, b, c))

    return Mesh(vertices, indices)


# -------------------------------------------------------------- coplanar regions


def find_coplanar_regions(
    mesh, angle_deg=DEFAULT_ANGLE_DEG, offset_tol=DEFAULT_OFFSET, min_area=DEFAULT_MIN_AREA
):
    # type: (Mesh, float, float, float) -> List[Region]
    """Group triangles into coplanar regions by flood fill.

    A candidate joins when its normal is within `angle_deg` of the region's RUNNING
    area-weighted normal and all three corners sit within `offset_tol` of the region
    plane. Testing against the region rather than the neighbouring triangle is what
    stops a gently curved surface being walked all the way around a cylinder one
    tolerable step at a time.
    """
    verts = mesh.vertices
    idx = mesh.indices
    tri_count = len(idx) // 3
    if tri_count == 0:
        return []

    edge_to_tris = {}  # type: Dict[Tuple[int, int], List[int]]
    for t in range(tri_count):
        a, b, c = idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]
        for p, q in ((a, b), (b, c), (c, a)):
            edge_to_tris.setdefault((p, q) if p < q else (q, p), []).append(t)

    normals = []  # type: List[Vec3]
    areas = []  # type: List[float]
    centroids = []  # type: List[Vec3]
    for t in range(tri_count):
        a, b, c = verts[idx[t * 3]], verts[idx[t * 3 + 1]], verts[idx[t * 3 + 2]]
        n = cross(sub(b, a), sub(c, a))
        areas.append(0.5 * length(n))
        normals.append(normalize(n))
        centroids.append(((a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0))

    cos_tol = math.cos(math.radians(angle_deg))
    visited = [False] * tri_count
    regions = []  # type: List[Region]

    for seed in range(tri_count):
        if visited[seed] or areas[seed] <= 0:
            continue

        visited[seed] = True
        an = [normals[seed][k] * areas[seed] for k in range(3)]
        ac = [centroids[seed][k] * areas[seed] for k in range(3)]
        total = areas[seed]
        tris = [seed]
        queue = [seed]

        while queue:
            t = queue.pop()
            a, b, c = idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]
            for p, q in ((a, b), (b, c), (c, a)):
                key = (p, q) if p < q else (q, p)
                for nb in edge_to_tris.get(key, ()):
                    if visited[nb] or areas[nb] <= 0:
                        continue
                    rn = normalize((an[0], an[1], an[2]))
                    rc = (ac[0] / total, ac[1] / total, ac[2] / total)
                    # abs(): a CAD export routinely has neighbouring facets wound
                    # opposite ways. They are the same physical surface and must merge,
                    # so compare the line the normal lies along, not its direction.
                    d = dot(normals[nb], rn)
                    if abs(d) < cos_tol:
                        continue
                    ok = True
                    for k in range(3):
                        if abs(dot(sub(verts[idx[nb * 3 + k]], rc), rn)) > offset_tol:
                            ok = False
                            break
                    if not ok:
                        continue

                    visited[nb] = True
                    tris.append(nb)
                    queue.append(nb)
                    # Keep the accumulation consistently oriented, or opposite-wound
                    # facets cancel and the region normal collapses towards zero.
                    orient = -1.0 if d < 0 else 1.0
                    for k in range(3):
                        an[k] += normals[nb][k] * areas[nb] * orient
                        ac[k] += centroids[nb][k] * areas[nb]
                    total += areas[nb]

        if total < min_area:
            continue

        normal = normalize((an[0], an[1], an[2]))
        point = (ac[0] / total, ac[1] / total, ac[2] / total)

        region_idx = []  # type: List[int]
        for t in tris:
            a, b, c = idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]
            # Re-wind to agree with the region normal so boundary extraction can rely
            # on consistent winding.
            if dot(normals[t], normal) < 0:
                region_idx.extend((a, c, b))
            else:
                region_idx.extend((a, b, c))

        area = 0.0
        for i in range(0, len(region_idx), 3):
            area += tri_area(verts[region_idx[i]], verts[region_idx[i + 1]], verts[region_idx[i + 2]])

        regions.append(Region(region_idx, normal, point, area))

    regions.sort(key=lambda r: -r.area)
    return regions


# ------------------------------------------------------------------- projection


class Basis(object):
    """Orthonormal frame for a plane, for projecting to 2D and back.

    The `u` axis comes from whichever world axis is least aligned with the normal, so it
    never degenerates. The 2D frame is arbitrary but stable, which is all that matters
    because everything projects and unprojects through the same basis.
    """

    def __init__(self, normal, point):
        # type: (Vec3, Vec3) -> None
        n = normalize(normal)
        ax, ay, az = abs(n[0]), abs(n[1]), abs(n[2])
        if ax <= ay and ax <= az:
            seed = (1.0, 0.0, 0.0)
        elif ay <= az:
            seed = (0.0, 1.0, 0.0)
        else:
            seed = (0.0, 0.0, 1.0)
        self.n = n
        self.origin = point
        self.u = normalize(cross(seed, n))
        self.v = cross(n, self.u)

    def to2d(self, p):
        # type: (Vec3) -> Pt2
        d = sub(p, self.origin)
        return (dot(d, self.u), dot(d, self.v))

    def to3d(self, xy):
        # type: (Pt2) -> Vec3
        x, y = xy
        return (
            self.origin[0] + self.u[0] * x + self.v[0] * y,
            self.origin[1] + self.u[1] * x + self.v[1] * y,
            self.origin[2] + self.u[2] * x + self.v[2] * y,
        )


def signed_area2(poly):
    # type: (Sequence[Pt2]) -> float
    a = 0.0
    n = len(poly)
    for i in range(n):
        j = (i - 1) % n
        a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
    return a


# ---------------------------------------------------------------------- boundary


def boundary_loops(region, mesh):
    # type: (Region, Mesh) -> List[List[int]]
    """Recover the boundary loops of a region, largest first.

    Every interior edge is traversed once in each direction by the two triangles sharing
    it; a boundary edge is traversed once. So directed edges with no opposing twin are
    exactly the boundary. Relies on the consistent winding applied by
    find_coplanar_regions.
    """
    directed = set()
    idx = region.indices
    for i in range(0, len(idx), 3):
        directed.add((idx[i], idx[i + 1]))
        directed.add((idx[i + 1], idx[i + 2]))
        directed.add((idx[i + 2], idx[i]))

    nxt = {}  # type: Dict[int, List[int]]
    for a, b in directed:
        if (b, a) in directed:
            continue  # interior
        nxt.setdefault(a, []).append(b)

    loops = []  # type: List[List[int]]
    guard = 0
    while nxt and guard < 1000000:
        start = next(iter(nxt))
        loop = []  # type: List[int]
        cur = start
        while guard < 1000000:
            guard += 1
            outs = nxt.get(cur)
            if not outs:
                break
            nx = outs.pop()
            if not outs:
                del nxt[cur]
            loop.append(cur)
            cur = nx
            if cur == start:
                break
        if len(loop) >= 3:
            loops.append(loop)

    basis = Basis(region.normal, region.point)
    loops.sort(key=lambda l: -abs(signed_area2([basis.to2d(mesh.vertices[i]) for i in l])))
    return loops


# -------------------------------------------------------------- simplification


def drop_collinear(poly, tol):
    # type: (Sequence[Pt2], float) -> List[Pt2]
    if len(poly) <= 3:
        return list(poly)
    out = []  # type: List[Pt2]
    n = len(poly)
    for i in range(n):
        p, c, q = poly[(i - 1) % n], poly[i], poly[(i + 1) % n]
        ax, ay = q[0] - p[0], q[1] - p[1]
        l = math.hypot(ax, ay)
        if l < 1e-12:
            d = math.hypot(c[0] - p[0], c[1] - p[1])
        else:
            d = abs(ax * (p[1] - c[1]) - ay * (p[0] - c[0])) / l
        if d > tol:
            out.append(c)
    return out if len(out) >= 3 else list(poly)


def _dp_chain(pts, tol):
    # type: (List[Pt2], float) -> List[Pt2]
    if len(pts) < 3:
        return pts
    first, last = pts[0], pts[-1]
    ax, ay = last[0] - first[0], last[1] - first[1]
    l = math.hypot(ax, ay)
    worst, worst_i = -1.0, 0
    for i in range(1, len(pts) - 1):
        p = pts[i]
        if l < 1e-12:
            d = math.hypot(p[0] - first[0], p[1] - first[1])
        else:
            d = abs(ax * (first[1] - p[1]) - ay * (first[0] - p[0])) / l
        if d > worst:
            worst, worst_i = d, i
    if worst <= tol:
        return [first, last]
    return _dp_chain(pts[: worst_i + 1], tol)[:-1] + _dp_chain(pts[worst_i:], tol)


def simplify_closed(poly, tol):
    # type: (Sequence[Pt2], float) -> List[Pt2]
    """Simplify a closed ring.

    Split at the two most distant vertices before running Douglas-Peucker: DP on a ring
    anchored at an arbitrary vertex will happily shave off the far side, which on a
    seating block means losing an entire back row.
    """
    pts = list(poly)
    if len(pts) <= 4:
        return pts
    bi = bj = 0
    best = -1.0
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
            if d > best:
                best, bi, bj = d, i, j
    a = pts[bi : bj + 1]
    b = pts[bj:] + pts[: bi + 1]
    merged = _dp_chain(a, tol)[:-1] + _dp_chain(b, tol)[:-1]
    return merged if len(merged) >= 3 else pts


def convex_hull(pts):
    # type: (Sequence[Pt2]) -> List[Pt2]
    if len(pts) < 3:
        return list(pts)
    s = sorted(set(pts))
    if len(s) < 3:
        return s

    def half(seq):
        out = []  # type: List[Pt2]
        for p in seq:
            while len(out) >= 2:
                o, a = out[-2], out[-1]
                if (a[0] - o[0]) * (p[1] - o[1]) - (a[1] - o[1]) * (p[0] - o[0]) <= 0:
                    out.pop()
                else:
                    break
            out.append(p)
        return out

    return half(s)[:-1] + half(list(reversed(s)))[:-1]


def min_area_rect(poly):
    # type: (Sequence[Pt2]) -> List[Pt2]
    """Smallest-area enclosing rectangle, by rotating calipers over each hull edge.

    For an audience plane this is usually the RIGHT answer, not an approximation: a
    seating block traced from CAD has a ragged outline describing the carpet, not the
    coverage area, and four corners is what a person would have drawn.
    """
    hull = convex_hull(poly)
    if len(hull) < 3:
        return list(poly)
    best = None
    best_area = float("inf")
    for i in range(len(hull)):
        p, q = hull[i], hull[(i + 1) % len(hull)]
        ex, ey = q[0] - p[0], q[1] - p[1]
        l = math.hypot(ex, ey)
        if l < 1e-12:
            continue
        ux, uy = ex / l, ey / l
        us = [h[0] * ux + h[1] * uy for h in hull]
        vs = [-h[0] * uy + h[1] * ux for h in hull]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if area < best_area:
            best_area = area
            def un(u, v):
                return (u * ux - v * uy, u * uy + v * ux)
            best = [
                un(min(us), min(vs)),
                un(max(us), min(vs)),
                un(max(us), max(vs)),
                un(min(us), max(vs)),
            ]
    return best if best else list(poly)


# --------------------------------------------------------------- venue-specific


def region_polygon(region, mesh, simplify_tol=DEFAULT_SIMPLIFY, rectangle=False):
    # type: (Region, Mesh, float, bool) -> List[Vec3]
    """A region's outer boundary as world-space points."""
    loops = boundary_loops(region, mesh)
    if not loops:
        return []
    basis = Basis(region.normal, region.point)
    poly = [basis.to2d(mesh.vertices[i]) for i in loops[0]]
    poly = simplify_closed(drop_collinear(poly, simplify_tol), simplify_tol)
    if rectangle:
        poly = min_area_rect(poly)
    return [basis.to3d(p) for p in poly]


def up_facing(regions, min_up=0.5):
    # type: (Sequence[Region], float) -> List[Region]
    """Roughly horizontal regions, highest first, ties broken by area.

    `min_up` is the smallest |normal.z| that still counts as horizontal — 0.5 is 60
    degrees, which keeps a steeply raked tier and rejects a wall.

    Sorted by HEIGHT, not by area. Area cannot tell a box's top from its bottom: they
    have the same area and the same |normal.z|. Nor can the sign of normal.z be trusted,
    because coplanar merging compares normals with abs() on purpose — a CAD export
    routinely has neighbouring facets wound opposite ways, and they must still merge.
    Height is the only property that actually means "top".
    """
    candidates = [r for r in regions if abs(r.normal[2]) >= min_up]
    return sorted(candidates, key=lambda r: (-_mean_z(r), -r.area))


def _mean_z(region):
    # type: (Region) -> float
    # The region carries its own plane point, which is the area-weighted centroid.
    return region.point[2]


def top_face(regions, min_up=0.5):
    # type: (Sequence[Region], float) -> Optional[Region]
    """The highest roughly-horizontal region.

    For an audience plane or a stage deck this is usually the whole answer: a solid has
    six or more faces and ArrayCalc only wants the one people occupy.

    LIMITATION: stepped seating, where each row is its own coplanar region at its own
    height, has no single top face — this returns the highest step only. `up_facing`
    exposes the full list so the caller can notice and say so.
    """
    faces = up_facing(regions, min_up)
    return faces[0] if faces else None


def as_box(triangles, tol=0.01):
    # type: (Sequence[float], float) -> Optional[Tuple[List[Vec3], List[Vec3]]]
    """Detect an axis-aligned box and return its bottom and top quads.

    Vectorworks extrudes that really are boxes — lighting bridges, proscenium legs,
    risers — map onto ArrayCalc's Shape=4 directly. One RoomObject instead of six.

    Deliberately strict: it only accepts a shape whose vertices are exactly the eight
    corners of its own bounding box. A near-box quietly turned into a box would move
    geometry, and a wrong reflector position is worse than six honest quads.
    """
    n = (len(triangles) // 9) * 9
    if n == 0:
        return None
    xs = triangles[0:n:3]
    ys = triangles[1:n:3]
    zs = triangles[2:n:3]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    z0, z1 = min(zs), max(zs)
    if x1 - x0 < tol or y1 - y0 < tol or z1 - z0 < tol:
        return None

    corners = set()
    for i in range(0, n, 3):
        px, py, pz = triangles[i], triangles[i + 1], triangles[i + 2]
        cx = x0 if abs(px - x0) <= tol else (x1 if abs(px - x1) <= tol else None)
        cy = y0 if abs(py - y0) <= tol else (y1 if abs(py - y1) <= tol else None)
        cz = z0 if abs(pz - z0) <= tol else (z1 if abs(pz - z1) <= tol else None)
        if cx is None or cy is None or cz is None:
            return None  # a vertex off the bounding box: not a box
        corners.add((cx, cy, cz))

    if len(corners) != 8:
        return None

    bottom = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)]
    top = [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    return bottom, top


def fan_quads(polygon):
    # type: (Sequence[Vec3]) -> List[List[Vec3]]
    """Split an n-gon into quads and triangles by fanning from its first vertex.

    Simpler than the browser tool's earcut-plus-quad-merge, and sufficient here: a
    Vectorworks face that has survived coplanar merging and simplification is almost
    always convex, and a fan of a convex polygon is valid. A concave outline still
    produces valid ArrayCalc geometry, just less tidily — use `rectangle=True` for those.
    """
    pts = list(polygon)
    if len(pts) < 3:
        return []
    if len(pts) <= 4:
        return [pts]
    out = []  # type: List[List[Vec3]]
    i = 1
    while i < len(pts) - 1:
        if i + 2 < len(pts):
            out.append([pts[0], pts[i], pts[i + 1], pts[i + 2]])
            i += 3
        else:
            out.append([pts[0], pts[i], pts[i + 1]])
            i += 2
    return out


def triangulate_polygon(points):
    # type: (Sequence[Vec3]) -> List[float]
    """Fan-triangulate a closed loop about its centroid, into a flat triangle stream."""
    pts = list(points)
    if len(pts) < 3:
        return []
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    cz = sum(p[2] for p in pts) / len(pts)
    out = []  # type: List[float]
    for i in range(len(pts)):
        a = pts[i]
        b = pts[(i + 1) % len(pts)]
        out.extend((cx, cy, cz, a[0], a[1], a[2], b[0], b[1], b[2]))
    return out
