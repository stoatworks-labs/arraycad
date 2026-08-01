"""The Python .dbacv writer must be as exact as the TypeScript one.

Runs without Vectorworks. `python3 -m pytest vectorworks/tests` from the repo root, or
`python3 vectorworks/tests/test_dbacv.py` for a plain-stdlib run.
"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from arraycad.dbacv import (  # noqa: E402
    PLANE_LISTENING,
    PLANE_SURFACE,
    SHAPE_ARC,
    SHAPE_BOX,
    SHAPE_GROUP,
    SHAPE_QUAD,
    SHAPE_TRIANGLE,
    RoomObject,
    VenueFile,
    g17,
    parse_dbacv,
    write_dbacv,
)

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "test", "fixtures", "theatre.dbacv")


def read_fixture():
    with open(FIXTURE, "r", encoding="utf-8") as fh:
        return fh.read()


def world_points(o):
    """World positions, APPLYING the Z rotation.

    Quads carry a real rotation now — ArrayCalc's canonical frame demands it. Simply
    adding the origin, which was correct while rotation was always zero, reports
    geometry in the wrong place.
    """
    r = math.radians(o.rotation[2])
    c, s = math.cos(r), math.sin(r)
    return [
        (p[0] * c - p[1] * s + o.origin[0], p[0] * s + p[1] * c + o.origin[1], p[2] + o.origin[2])
        for p in o.points
    ]


class TestG17(unittest.TestCase):
    """Every literal here is lifted verbatim from the ArrayCalc fixture."""

    CASES = [
        (0.0, "0"),
        (1.0, "1"),
        (7.0, "7"),
        (1.2, "1.2"),
        (1.7, "1.7"),
        (0.01, "0.01"),
        (13.06, "13.06"),
        (5.405, "5.4050000000000002"),
        (3.2, "3.2000000000000002"),
        (9.6, "9.5999999999999996"),
        (0.4, "0.40000000000000002"),
        (-72.7, "-72.700000000000003"),
        (2.160000000000001, "2.160000000000001"),
        (1.4115441436226934, "1.4115441436226934"),
        (12.978861061695445, "12.978861061695445"),
        (351.66496511560081, "351.66496511560081"),
        (0.027708879191155944, "0.027708879191155944"),
        (0.60000000000000053, "0.60000000000000053"),
        (-8.8817841970012523e-16, "-8.8817841970012523e-16"),
    ]

    def test_matches_arraycalc(self):
        for value, expected in self.CASES:
            self.assertEqual(g17(value), expected, "for {!r}".format(value))

    def test_round_trips_every_double(self):
        import random

        random.seed(20260801)
        for _ in range(5000):
            v = (random.random() - 0.5) * 10 ** random.randint(-10, 10)
            self.assertEqual(float(g17(v)), v)

    def test_non_finite(self):
        self.assertEqual(g17(float("nan")), "nan")
        self.assertEqual(g17(float("inf")), "inf")
        self.assertEqual(g17(float("-inf")), "-inf")


class TestRoundTrip(unittest.TestCase):
    def setUp(self):
        self.xml = read_fixture()
        self.venue = parse_dbacv(self.xml)

    def test_reemits_the_fixture_byte_for_byte(self):
        out = write_dbacv(self.venue)
        want = self.xml.split("\n")
        got = out.split("\n")
        self.assertEqual(
            len(got), len(want), "line count: got {} want {}".format(len(got), len(want))
        )
        for i, (a, b) in enumerate(zip(want, got)):
            if a != b:
                self.fail("line {}\n  want: {}\n  got:  {}".format(i + 1, a, b))
        self.assertEqual(out, self.xml)

    def test_survives_a_second_trip(self):
        once = write_dbacv(self.venue)
        twice = write_dbacv(parse_dbacv(once))
        self.assertEqual(once, twice)

    def test_reads_the_whole_tree(self):
        count = [0]

        def walk(objects):
            for o in objects:
                count[0] += 1
                walk(o.children)

        walk(self.venue.objects)
        self.assertEqual(count[0], 112)
        self.assertEqual(self.venue.app_version, "12.8.2")
        self.assertEqual(self.venue.venue_version, "9")

    def test_shapes_present(self):
        shapes = set()

        def walk(objects):
            for o in objects:
                shapes.add(o.shape)
                walk(o.children)

        walk(self.venue.objects)
        self.assertEqual(shapes, {SHAPE_QUAD, SHAPE_ARC, SHAPE_BOX, SHAPE_GROUP, SHAPE_TRIANGLE})

    def test_preserves_a_non_numeric_listener_height(self):
        raw = [o for o in self.venue.objects if o.listener_height_raw is not None]
        self.assertEqual(len(raw), 1)
        self.assertEqual(raw[0].listener_height_raw, "nan")
        self.assertFalse(math.isnan(raw[0].listener_height))

    def test_parent_ids_renumber_when_an_object_is_pruned(self):
        # Drop MIX POSITION (document index 2). The first group was index 6 and must
        # become 5, and its children must follow it.
        del self.venue.objects[1]
        out = write_dbacv(self.venue)
        self.assertIn('ParentVenueObjectId="5"', out)
        self.assertNotIn('ParentVenueObjectId="6"', out)


class TestConstruction(unittest.TestCase):
    def test_quad_uses_arraycalcs_canonical_frame_not_the_centroid(self):
        # The bug the ArrayCalc round trip caught: a centroid origin round-trips fine
        # through our own reader and is silently collapsed to zero depth on import.
        o = RoomObject.from_face(
            "Deck", [(0, 0, 0), (10, 0, 0), (10, 6, 0), (0, 6, 0)], PLANE_LISTENING
        )
        self.assertEqual(o.shape, SHAPE_QUAD)
        self.assertAlmostEqual(o.points[0][0], 0.0)  # near edge at local x = 0
        self.assertAlmostEqual(o.points[3][0], 0.0)
        self.assertAlmostEqual(o.points[0][1], -o.points[3][1])  # symmetric
        self.assertNotAlmostEqual(o.origin[0], 5.0)  # NOT the centroid
        self.assertEqual(o.listener_height, 1.2)
        # And the geometry is still a 10 x 6 rectangle in the same place.
        world = world_points(o)
        xs = [p[0] for p in world]
        ys = [p[1] for p in world]
        self.assertAlmostEqual(min(xs), 0.0)
        self.assertAlmostEqual(max(xs), 10.0)
        self.assertAlmostEqual(min(ys), 0.0)
        self.assertAlmostEqual(max(ys), 6.0)

    def test_a_quad_that_cannot_be_canonical_becomes_two_triangles(self):
        sheared = [(0, 0, 0), (4, 0, 0), (5, 3, 0), (1, 3, 0)]
        self.assertIsNone(RoomObject.from_face("X", sheared, PLANE_LISTENING))
        got = RoomObject.faces_for("X", sheared, PLANE_LISTENING)
        self.assertEqual(len(got), 2)
        self.assertTrue(all(o.shape == SHAPE_TRIANGLE for o in got))

    def test_a_vertical_quad_is_depth_zero_with_a_rise(self):
        # How the reference venue stores every rail front.
        wall = [(0, 5, 0), (0, 5, -0.83), (0, -5, -0.83), (0, -5, 0)]
        o = RoomObject.from_face("Rail", wall, PLANE_SURFACE)
        self.assertIsNotNone(o)
        self.assertAlmostEqual(o.points[1][0], 0.0)
        self.assertAlmostEqual(abs(o.points[1][2]), 0.83)

    def test_triangle(self):
        o = RoomObject.from_face("T", [(0, 0, 0), (4, 0, 0), (0, 4, 0)], PLANE_SURFACE)
        self.assertEqual(o.shape, SHAPE_TRIANGLE)
        self.assertEqual(len(o.points), 3)
        self.assertEqual(o.listener_height, 0.01)

    def test_rejects_a_face_that_is_not_a_tri_or_quad(self):
        self.assertIsNone(RoomObject.from_face("X", [(0, 0, 0), (1, 0, 0)], PLANE_LISTENING))
        self.assertIsNone(
            RoomObject.from_face(
                "X", [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0.5, 0)], PLANE_LISTENING
            )
        )

    def test_box_is_one_object_not_six(self):
        bottom = [(0, 0, 0), (4, 0, 0), (4, 2, 0), (0, 2, 0)]
        top = [(0, 0, 3), (4, 0, 3), (4, 2, 3), (0, 2, 3)]
        o = RoomObject.from_box("Bridge", bottom, top, PLANE_SURFACE)
        self.assertEqual(o.shape, SHAPE_BOX)
        self.assertEqual(len(o.points), 8)
        self.assertAlmostEqual(o.origin[2], 1.5)

    def test_written_output_parses_back(self):
        v = VenueFile(
            objects=[
                RoomObject.group(
                    "Seating",
                    children=[
                        RoomObject.from_face(
                            "Row {}".format(i),
                            [(0, i, 0), (10, i, 0), (10, i + 1, 0.2), (0, i + 1, 0.2)],
                            PLANE_LISTENING,
                            order_index=i,
                        )
                        for i in range(3)
                    ],
                )
            ],
            project_name="Test",
        )
        reparsed = parse_dbacv(write_dbacv(v))
        self.assertEqual(len(reparsed.objects), 1)
        self.assertEqual(reparsed.objects[0].shape, SHAPE_GROUP)
        self.assertEqual(len(reparsed.objects[0].children), 3)
        self.assertEqual(reparsed.project_name, "Test")

    def test_group_children_are_written_before_its_transform(self):
        v = VenueFile(
            objects=[
                RoomObject.group(
                    "G",
                    children=[
                        RoomObject.from_face(
                            "F", [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], PLANE_LISTENING
                        )
                    ],
                )
            ]
        )
        out = write_dbacv(v)
        # The group's own Origin must come after the child's closing tag.
        child_close = out.index("</RoomObject>")
        group_origin = out.rindex("<Origin")
        self.assertGreater(group_origin, child_close)


if __name__ == "__main__":
    unittest.main(verbosity=2)
