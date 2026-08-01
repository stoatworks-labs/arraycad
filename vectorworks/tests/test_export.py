"""The export decision logic, driven with fake geometry.

`export.run` never touches `vs` — it takes triangles that something else produced — so
the whole strategy layer is testable here. Only `vwbridge.py` needs Vectorworks, and
that is exactly why the two are separate files.
"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from arraycad.dbacv import (  # noqa: E402
    PLANE_AUDIENCE,
    PLANE_STAGE,
    PLANE_SURFACE,
    SHAPE_BOX,
    SHAPE_GROUP,
    SHAPE_QUAD,
    SHAPE_TRIANGLE,
    parse_dbacv,
)
from arraycad.export import (  # noqa: E402
    STRATEGY_BOX,
    STRATEGY_FACES,
    STRATEGY_TOP,
    ClassRule,
    Options,
    SourceObject,
    convert_source,
    run,
    to_xml,
)


def quad_xy(w, d, h=0.0):
    return [0, 0, h, w, 0, h, w, d, h, 0, 0, h, w, d, h, 0, d, h]


def box_tris(w, d, hgt, z0=0.0):
    p = [
        (0, 0, z0), (w, 0, z0), (w, d, z0), (0, d, z0),
        (0, 0, z0 + hgt), (w, 0, z0 + hgt), (w, d, z0 + hgt), (0, d, z0 + hgt),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7),
    ]
    out = []
    for f in faces:
        for i in f:
            out.extend(p[i])
    return out


class TestStrategies(unittest.TestCase):
    def test_box_strategy_gives_one_shape4_object(self):
        src = SourceObject("BRIDGE 1", box_tris(0.9, 14, 2.16), "Rigging")
        objs, _, _ = convert_source(src, ClassRule(PLANE_SURFACE, STRATEGY_BOX), Options())
        self.assertEqual(len(objs), 1)
        self.assertEqual(objs[0].shape, SHAPE_BOX)
        self.assertEqual(len(objs[0].points), 8)
        self.assertEqual(objs[0].name, "BRIDGE 1")

    def test_faces_strategy_gives_six_for_the_same_box(self):
        src = SourceObject("Solid", box_tris(4, 3, 2), "Walls")
        objs, found, _ = convert_source(src, ClassRule(PLANE_SURFACE, STRATEGY_FACES), Options())
        self.assertEqual(found, 6)
        self.assertEqual(len(objs), 6)
        self.assertTrue(all(o.shape == SHAPE_QUAD for o in objs))

    def test_top_strategy_gives_one_plane_at_the_top(self):
        # The regression that caught this: a box's top and bottom have identical area
        # and identical |normal.z|, so picking "the largest horizontal face" returned
        # the FLOOR of the seating block. Height is the only thing that means "top".
        src = SourceObject("STALLS", box_tris(20, 12, 1.5), "Seating")
        objs, _, _ = convert_source(src, ClassRule(PLANE_AUDIENCE, STRATEGY_TOP), Options())
        self.assertEqual(len(objs), 1)
        world_z = [p[2] + objs[0].origin[2] for p in objs[0].points]
        for z in world_z:
            self.assertAlmostEqual(z, 1.5, places=6)

    def test_top_strategy_warns_about_stepped_seating(self):
        # Three separate risers: there is no single top face, and exporting only the
        # highest step would silently lose two thirds of the seating.
        tris = []
        for i in range(3):
            step = box_tris(10, 2, 0.4 + i * 0.4)
            for j in range(0, len(step), 3):
                step[j + 1] += i * 2  # move each step back in y
            tris.extend(step)
        src = SourceObject("Stepped", tris, "Seating")
        objs, _, warnings = convert_source(src, ClassRule(PLANE_AUDIENCE, STRATEGY_TOP), Options())
        self.assertEqual(len(objs), 1)
        self.assertTrue(
            any("stepped seating" in w for w in warnings),
            "expected a stepped-seating warning, got {}".format(warnings),
        )

    def test_auto_uses_box_when_it_is_a_box(self):
        src = SourceObject("Riser", box_tris(2, 1, 0.6), "Staging")
        objs, _, _ = convert_source(src, ClassRule(PLANE_STAGE), Options())
        self.assertEqual(objs[0].shape, SHAPE_BOX)

    def test_auto_uses_top_face_for_audience_when_not_a_box(self):
        # A raked deck: a box with its top sloped, so it is not a box any more.
        tris = box_tris(10, 8, 2)
        # Lift two of the top corners.
        for i in range(0, len(tris), 3):
            if abs(tris[i + 2] - 2.0) < 1e-9 and tris[i + 1] > 4:
                tris[i + 2] = 3.0
        src = SourceObject("Raked stalls", tris, "Seating")
        objs, _, _ = convert_source(src, ClassRule(PLANE_AUDIENCE), Options())
        self.assertEqual(len(objs), 1)
        zs = [p[2] + objs[0].origin[2] for p in objs[0].points]
        self.assertGreater(max(zs), 2.5)

    def test_auto_uses_all_faces_for_a_surface(self):
        tris = box_tris(10, 8, 2)
        for i in range(0, len(tris), 3):
            if abs(tris[i + 2] - 2.0) < 1e-9 and tris[i + 1] > 4:
                tris[i + 2] = 3.0
        src = SourceObject("Ceiling solid", tris, "Ceilings")
        objs, _, _ = convert_source(src, ClassRule(PLANE_SURFACE), Options())
        self.assertGreater(len(objs), 1)

    def test_box_strategy_falls_back_and_warns_when_it_is_not_a_box(self):
        src = SourceObject("Not a box", quad_xy(10, 5), "Rigging")
        objs, _, warnings = convert_source(src, ClassRule(PLANE_SURFACE, STRATEGY_BOX), Options())
        self.assertEqual(len(objs), 1)
        self.assertEqual(objs[0].shape, SHAPE_QUAD)
        self.assertTrue(any("is not a box" in w for w in warnings))

    def test_top_strategy_falls_back_and_warns_with_no_upward_face(self):
        wall = [0, 0, 0, 10, 0, 0, 10, 0, 5, 0, 0, 0, 10, 0, 5, 0, 0, 5]
        src = SourceObject("Wall", wall, "Walls")
        objs, _, warnings = convert_source(src, ClassRule(PLANE_AUDIENCE, STRATEGY_TOP), Options())
        self.assertTrue(any("no upward-facing surface" in w for w in warnings))
        self.assertGreater(len(objs), 0)

    def test_rectangle_fit_collapses_a_ragged_outline(self):
        tris = quad_xy(10, 5) + [10, 0, 0, 12, 2.5, 0, 10, 5, 0]
        src = SourceObject("Ragged", tris, "Seating")
        plain, _, _ = convert_source(src, ClassRule(PLANE_AUDIENCE, STRATEGY_FACES), Options())
        rect, _, _ = convert_source(
            src, ClassRule(PLANE_AUDIENCE, STRATEGY_FACES, rectangle=True), Options()
        )
        self.assertEqual(len(rect), 1)
        self.assertEqual(rect[0].shape, SHAPE_QUAD)
        self.assertGreaterEqual(len(plain), 1)

    def test_object_cap_keeps_the_largest(self):
        src = SourceObject("Solid", box_tris(4, 3, 2), "Walls")
        objs, _, warnings = convert_source(
            src, ClassRule(PLANE_SURFACE, STRATEGY_FACES), Options(max_objects_per_source=2)
        )
        self.assertEqual(len(objs), 2)
        self.assertTrue(any("capped at 2" in w for w in warnings))

    def test_empty_source(self):
        objs, found, _ = convert_source(SourceObject("Empty", [], "X"), ClassRule(), Options())
        self.assertEqual(objs, [])
        self.assertEqual(found, 0)


class TestRun(unittest.TestCase):
    def sources(self):
        return [
            SourceObject("STALLS", box_tris(20, 12, 1.0), "Seating"),
            SourceObject("BALCONY", box_tris(18, 5, 0.8, z0=6.0), "Seating"),
            SourceObject("STAGE", box_tris(14, 9, 1.05), "Staging"),
            SourceObject("BRIDGE", box_tris(0.9, 14, 2.16, z0=8.0), "Rigging"),
            SourceObject("LX TRUSS", box_tris(0.5, 12, 0.5, z0=9.0), "Lighting"),
        ]

    def rules(self):
        return {
            "Seating": ClassRule(PLANE_AUDIENCE, STRATEGY_TOP),
            "Staging": ClassRule(PLANE_STAGE, STRATEGY_TOP),
            "Rigging": ClassRule(PLANE_SURFACE, STRATEGY_BOX),
            "Lighting": ClassRule(include=False),
        }

    def test_excluded_classes_are_dropped(self):
        result = run(self.sources(), self.rules())
        self.assertEqual(result.sources_in, 4)
        names = [o.name for o in result.objects]
        self.assertNotIn("LX TRUSS", names)
        self.assertIn("STALLS", names)

    def test_plane_types_follow_the_class_rules(self):
        result = run(self.sources(), self.rules())
        by_name = dict((o.name, o) for o in result.objects)
        self.assertEqual(by_name["STALLS"].plane_type, PLANE_AUDIENCE)
        self.assertEqual(by_name["STAGE"].plane_type, PLANE_STAGE)
        self.assertEqual(by_name["BRIDGE"].plane_type, PLANE_SURFACE)
        self.assertEqual(by_name["STALLS"].listener_height, 1.2)
        self.assertEqual(by_name["BRIDGE"].listener_height, 0.01)

    def test_the_bridge_stays_a_single_box(self):
        result = run(self.sources(), self.rules())
        bridge = [o for o in result.objects if o.name == "BRIDGE"][0]
        self.assertEqual(bridge.shape, SHAPE_BOX)

    def test_no_group_of_one(self):
        result = run(self.sources(), self.rules())
        for o in result.objects:
            if o.shape == SHAPE_GROUP:
                self.assertGreater(len(o.children), 1)

    def test_output_is_a_valid_dbacv(self):
        result = run(self.sources(), self.rules())
        xml = to_xml(result, "Theatre")
        venue = parse_dbacv(xml)
        self.assertEqual(venue.project_name, "Theatre")
        self.assertEqual(venue.author, "ArrayCAD")

        count = [0]

        def walk(objects):
            for o in objects:
                count[0] += 1
                if o.shape != SHAPE_GROUP:
                    self.assertIn(o.shape, (SHAPE_QUAD, SHAPE_TRIANGLE, SHAPE_BOX))
                walk(o.children)

        walk(venue.objects)
        self.assertGreater(count[0], 0)

    def test_geometry_lands_where_it_started(self):
        result = run(self.sources(), self.rules())
        xml = to_xml(result, "Theatre")
        venue = parse_dbacv(xml)

        pts = []

        def walk(objects):
            for o in objects:
                # Apply the Z rotation: canonical quads carry one, and ignoring it
                # reports geometry in the wrong place.
                r = math.radians(o.rotation[2])
                c, s = math.cos(r), math.sin(r)
                for p in o.points:
                    pts.append(
                        (
                            p[0] * c - p[1] * s + o.origin[0],
                            p[0] * s + p[1] * c + o.origin[1],
                            p[2] + o.origin[2],
                        )
                    )
                walk(o.children)

        walk(venue.objects)
        xs = [p[0] for p in pts]
        zs = [p[2] for p in pts]
        # The stalls span x 0..20 and the bridge sits at z 8..10.16.
        self.assertAlmostEqual(min(xs), 0.0, places=3)
        self.assertAlmostEqual(max(xs), 20.0, places=3)
        self.assertAlmostEqual(max(zs), 10.16, places=3)

    def test_unknown_class_uses_the_default_rule(self):
        sources = [SourceObject("Mystery", box_tris(4, 4, 1), "Something Else")]
        result = run(sources, {}, default_rule=ClassRule(PLANE_SURFACE, STRATEGY_FACES))
        self.assertGreater(len(result.objects), 0)
        target = result.objects[0]
        if target.shape == SHAPE_GROUP:
            target = target.children[0]
        self.assertEqual(target.plane_type, PLANE_SURFACE)

    def test_a_document_with_nothing_included(self):
        result = run(self.sources(), {"Seating": ClassRule(include=False)}, default_rule=ClassRule(include=False))
        self.assertEqual(result.objects, [])
        self.assertEqual(result.objects_out, 0)
        # And it still writes a structurally valid, empty venue.
        venue = parse_dbacv(to_xml(result, "Empty"))
        self.assertEqual(venue.objects, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
