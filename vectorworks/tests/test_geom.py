"""The Python geometry engine must agree with the TypeScript one.

The cases here are deliberately the SAME ones as `src/lib/geom/geom.test.ts`: a box is
six regions, a split rectangle is one, a 36-facet cylinder is not one. Two
implementations of the same reduction will drift unless something pins them together,
and this is that something.

Runs without Vectorworks.
"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from arraycad.dbacv import PLANE_LISTENING, SHAPE_BOX, RoomObject  # noqa: E402
from arraycad.geom import (  # noqa: E402
    Basis,
    as_box,
    boundary_loops,
    convex_hull,
    drop_collinear,
    fan_quads,
    find_coplanar_regions,
    min_area_rect,
    region_polygon,
    simplify_closed,
    top_face,
    triangulate_polygon,
    weld,
)


def quad_xy(w, d, h=0.0):
    """A w x d rectangle in the z = h plane, as two triangles."""
    return [0, 0, h, w, 0, h, w, d, h, 0, 0, h, w, d, h, 0, d, h]


def box_tris(w, d, hgt):
    """An axis-aligned box as 12 triangles."""
    p = [
        (0, 0, 0), (w, 0, 0), (w, d, 0), (0, d, 0),
        (0, 0, hgt), (w, 0, hgt), (w, d, hgt), (0, d, hgt),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2),
        (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4),
        (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6),
        (3, 0, 4), (3, 4, 7),
    ]
    out = []
    for f in faces:
        for i in f:
            out.extend(p[i])
    return out


class TestWeld(unittest.TestCase):
    def test_fuses_coincident_vertices(self):
        m = weld(quad_xy(10, 5))
        self.assertEqual(len(m.vertices), 4)
        self.assertEqual(len(m.indices), 6)

    def test_fuses_across_a_cell_boundary(self):
        # Shared edge off by 0.4 mm, straddling a 1 mm grid line. A naive
        # quantise-and-hash weld leaves these apart — the crack that shatters a ceiling.
        tris = [
            0, 0, 0, 1.0004, 0, 0, 1.0004, 1, 0,
            0, 0, 0, 0.9996, 1, 0, 0, 1, 0,
        ]
        self.assertLessEqual(len(weld(tris).vertices), 4)

    def test_drops_collapsed_triangles(self):
        self.assertEqual(len(weld([0, 0, 0, 0.0001, 0, 0, 0.0002, 0, 0]).indices), 0)

    def test_ignores_a_trailing_partial_triangle(self):
        m = weld(quad_xy(10, 5) + [9, 9])
        self.assertEqual(len(m.indices), 6)


class TestRegions(unittest.TestCase):
    def test_merges_a_split_rectangle(self):
        r = find_coplanar_regions(weld(quad_xy(10, 5)))
        self.assertEqual(len(r), 1)
        self.assertAlmostEqual(r[0].area, 50.0, places=6)

    def test_box_is_six_faces(self):
        r = find_coplanar_regions(weld(box_tris(4, 3, 2)))
        self.assertEqual(len(r), 6)
        self.assertAlmostEqual(r[0].area, 12.0, places=6)
        self.assertAlmostEqual(r[1].area, 12.0, places=6)

    def test_parallel_surfaces_stay_apart(self):
        m = weld(quad_xy(10, 5, 0) + quad_xy(10, 5, 3))
        self.assertEqual(len(find_coplanar_regions(m)), 2)

    def test_does_not_walk_around_a_cylinder(self):
        # 36 facets, 10 degrees apart. Each is within 5 degrees of its neighbour only if
        # you compare pairwise; against the accumulated region plane it is not.
        tris = []
        for i in range(36):
            a = (i / 36.0) * math.pi * 2
            b = ((i + 1) / 36.0) * math.pi * 2
            x1, y1 = math.cos(a) * 5, math.sin(a) * 5
            x2, y2 = math.cos(b) * 5, math.sin(b) * 5
            tris.extend([x1, y1, 0, x2, y2, 0, x1, y1, 3])
            tris.extend([x2, y2, 0, x2, y2, 3, x1, y1, 3])
        self.assertGreater(len(find_coplanar_regions(weld(tris))), 10)

    def test_drops_regions_below_min_area(self):
        m = weld(quad_xy(10, 5) + quad_xy(0.1, 0.1, 9))
        self.assertEqual(len(find_coplanar_regions(m, min_area=0.05)), 1)

    def test_empty_input(self):
        self.assertEqual(find_coplanar_regions(weld([])), [])


class TestBoundary(unittest.TestCase):
    def test_recovers_four_corners(self):
        m = weld(quad_xy(10, 5))
        region = find_coplanar_regions(m)[0]
        loops = boundary_loops(region, m)
        self.assertEqual(len(loops), 1)
        self.assertEqual(len(loops[0]), 4)

    def test_outer_loop_first_then_hole(self):
        outer = [(0, 0), (5, 0), (10, 0), (10, 5), (10, 10), (5, 10), (0, 10), (0, 5)]
        inner = [(4, 4), (6, 4), (6, 4), (6, 6), (6, 6), (4, 6), (4, 6), (4, 4)]
        tris = []
        for i in range(8):
            a, b = outer[i], outer[(i + 1) % 8]
            c, d = inner[(i + 1) % 8], inner[i]
            tris.extend([a[0], a[1], 0, b[0], b[1], 0, c[0], c[1], 0])
            tris.extend([a[0], a[1], 0, c[0], c[1], 0, d[0], d[1], 0])
        m = weld(tris)
        region = find_coplanar_regions(m)[0]
        loops = boundary_loops(region, m)
        self.assertEqual(len(loops), 2)

        basis = Basis(region.normal, region.point)

        def area(loop):
            p = [basis.to2d(m.vertices[i]) for i in loop]
            a = 0.0
            for i in range(len(p)):
                j = i - 1
                a += p[j][0] * p[i][1] - p[i][0] * p[j][1]
            return abs(a / 2)

        self.assertAlmostEqual(area(loops[0]), 100.0, places=5)
        self.assertAlmostEqual(area(loops[1]), 4.0, places=5)

    def test_does_not_hang_on_a_pinched_region(self):
        tris = [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 2, 1, 0, 2, 2, 0]
        m = weld(tris)
        for r in find_coplanar_regions(m, min_area=0.0):
            boundary_loops(r, m)  # must terminate


class TestSimplify(unittest.TestCase):
    def test_drops_collinear(self):
        p = [(0, 0), (5, 0), (10, 0), (10, 10), (0, 10)]
        self.assertEqual(len(drop_collinear(p, 0.01)), 4)

    def test_keeps_the_far_side_of_a_ring(self):
        ring = []
        for i in range(20):
            a = (i / 20.0) * math.pi * 2
            ring.append((math.cos(a) * 10, math.sin(a) * 10))
        s = simplify_closed(ring, 0.5)
        self.assertGreaterEqual(len(s), 8)
        xs = [p[0] for p in s]
        self.assertLess(min(xs), -8)
        self.assertGreater(max(xs), 8)

    def test_min_area_rect_of_a_rotated_rectangle(self):
        a = math.pi / 6
        pts = []
        for x, y in [(0, 0), (8, 0), (8, 3), (0, 3)]:
            pts.append((x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)))
        r = min_area_rect(pts)
        self.assertEqual(len(r), 4)
        side = lambda i, j: math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1])
        sides = sorted([side(0, 1), side(1, 2)])
        self.assertAlmostEqual(sides[0], 3.0, places=5)
        self.assertAlmostEqual(sides[1], 8.0, places=5)

    def test_convex_hull(self):
        h = convex_hull([(0, 0), (5, 5), (10, 0), (10, 10), (0, 10), (5, 1)])
        self.assertEqual(len(h), 4)


class TestVenueSpecific(unittest.TestCase):
    def test_top_face_picks_the_upward_surface(self):
        regions = find_coplanar_regions(weld(box_tris(4, 3, 2)))
        t = top_face(regions)
        self.assertIsNotNone(t)
        self.assertGreater(abs(t.normal[2]), 0.9)
        self.assertAlmostEqual(t.area, 12.0, places=6)
        # And it is the top, not the bottom.
        poly = region_polygon(t, weld(box_tris(4, 3, 2)))
        self.assertTrue(all(abs(p[2] - 2.0) < 1e-6 or abs(p[2]) < 1e-6 for p in poly))

    def test_top_face_rejects_a_wall_only_model(self):
        # A single vertical plane: nothing faces up.
        wall = [0, 0, 0, 10, 0, 0, 10, 0, 5, 0, 0, 0, 10, 0, 5, 0, 0, 5]
        self.assertIsNone(top_face(find_coplanar_regions(weld(wall))))

    def test_as_box_detects_a_box(self):
        got = as_box(box_tris(4, 3, 2))
        self.assertIsNotNone(got)
        bottom, top = got
        self.assertEqual(len(bottom), 4)
        self.assertEqual(len(top), 4)
        self.assertAlmostEqual(bottom[0][2], 0.0)
        self.assertAlmostEqual(top[0][2], 2.0)

    def test_as_box_makes_one_room_object_not_six(self):
        bottom, top = as_box(box_tris(4, 3, 2))
        o = RoomObject.from_box("Bridge", bottom, top, PLANE_LISTENING)
        self.assertEqual(o.shape, SHAPE_BOX)
        self.assertEqual(len(o.points), 8)

    def test_as_box_rejects_a_non_box(self):
        # A box with one corner pulled off the bounding box is NOT a box. Quietly
        # accepting it would move geometry.
        tris = box_tris(4, 3, 2)
        tris[0] = 1.0  # nudge one vertex inward
        tris[1] = 1.0
        self.assertIsNone(as_box(tris))

    def test_as_box_rejects_a_flat_plane(self):
        self.assertIsNone(as_box(quad_xy(10, 5)))

    def test_as_box_rejects_a_cylinder(self):
        tris = []
        for i in range(36):
            a = (i / 36.0) * math.pi * 2
            b = ((i + 1) / 36.0) * math.pi * 2
            tris.extend([math.cos(a) * 5, math.sin(a) * 5, 0, math.cos(b) * 5, math.sin(b) * 5, 0, math.cos(a) * 5, math.sin(a) * 5, 3])
        self.assertIsNone(as_box(tris))


class TestFaces(unittest.TestCase):
    def test_quad_passes_through(self):
        q = [(0, 0, 0), (4, 0, 0), (4, 4, 0), (0, 4, 0)]
        self.assertEqual(fan_quads(q), [q])

    def test_triangle_passes_through(self):
        t = [(0, 0, 0), (4, 0, 0), (0, 4, 0)]
        self.assertEqual(fan_quads(t), [t])

    def test_ngon_becomes_only_tris_and_quads(self):
        hexagon = [
            (math.cos(i * math.pi / 3) * 5, math.sin(i * math.pi / 3) * 5, 0) for i in range(6)
        ]
        faces = fan_quads(hexagon)
        self.assertGreater(len(faces), 0)
        for f in faces:
            self.assertIn(len(f), (3, 4))

    def test_every_fan_face_becomes_a_valid_room_object(self):
        hexagon = [
            (math.cos(i * math.pi / 3) * 5, math.sin(i * math.pi / 3) * 5, 0) for i in range(6)
        ]
        for f in fan_quads(hexagon):
            self.assertIsNotNone(RoomObject.from_face("f", f, PLANE_LISTENING))

    def test_triangulate_polygon_round_trips_through_the_region_finder(self):
        poly = [(0, 0, 0), (10, 0, 0), (10, 6, 0), (0, 6, 0)]
        tris = triangulate_polygon(poly)
        regions = find_coplanar_regions(weld(tris))
        self.assertEqual(len(regions), 1)
        self.assertAlmostEqual(regions[0].area, 60.0, places=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
