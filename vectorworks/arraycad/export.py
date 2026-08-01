"""The export job: Vectorworks document -> .dbacv.

Split from the plug-in entry point so the decision logic can be exercised without
Vectorworks — `run()` takes a source of triangles rather than reaching for `vs` itself,
and `tests/test_export.py` drives it with fakes.

The per-class strategy is the interesting part. Unlike the browser tool, which meets an
anonymous triangle soup, this runs where the user has already classified everything, so
it can do better than generic planarization:

  TOP     one plane from the HIGHEST roughly-horizontal surface. Right for seating and
          stage decks, where ArrayCalc wants the surface people occupy, not all six
          faces of the solid. Warns if the object turns out to be stepped, where there
          is no single top face to take.
  BOX     one Shape=4 RoomObject when the object really is a box. Right for lighting
          bridges and proscenium legs.
  FACES   every coplanar region. Right for walls, ceilings and reflectors.
  AUTO    box if it is one, else top face for audience/stage, else all faces.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from .dbacv import (
    PLANE_AUDIENCE,
    PLANE_STAGE,
    RoomObject,
    VenueFile,
    write_dbacv,
)
from .geom import (
    DEFAULT_ANGLE_DEG,
    DEFAULT_MIN_AREA,
    DEFAULT_OFFSET,
    DEFAULT_SIMPLIFY,
    as_box,
    fan_quads,
    find_coplanar_regions,
    region_polygon,
    up_facing,
    weld,
)

STRATEGY_AUTO = "auto"
STRATEGY_TOP = "top"
STRATEGY_BOX = "box"
STRATEGY_FACES = "faces"

STRATEGIES = (STRATEGY_AUTO, STRATEGY_TOP, STRATEGY_BOX, STRATEGY_FACES)


class SourceObject(object):
    """One Vectorworks object, already reduced to world-space triangles in METRES."""

    def __init__(self, name, triangles, class_name="", layer=""):
        # type: (str, Sequence[float], str, str) -> None
        self.name = name
        self.triangles = list(triangles)
        self.class_name = class_name
        self.layer = layer


class ClassRule(object):
    """What to do with everything in one Vectorworks class."""

    def __init__(self, plane_type=PLANE_AUDIENCE, strategy=STRATEGY_AUTO, rectangle=False, include=True):
        # type: (int, str, bool, bool) -> None
        self.plane_type = plane_type
        self.strategy = strategy
        self.rectangle = rectangle
        self.include = include


class Options(object):
    def __init__(
        self,
        angle_deg=DEFAULT_ANGLE_DEG,
        offset_tol=DEFAULT_OFFSET,
        min_area=DEFAULT_MIN_AREA,
        simplify_tol=DEFAULT_SIMPLIFY,
        max_objects_per_source=0,
    ):
        self.angle_deg = angle_deg
        self.offset_tol = offset_tol
        self.min_area = min_area
        self.simplify_tol = simplify_tol
        self.max_objects_per_source = max_objects_per_source


class Result(object):
    def __init__(self):
        self.objects = []  # type: List[RoomObject]
        self.warnings = []  # type: List[str]
        self.sources_in = 0
        self.triangles_in = 0
        self.regions_found = 0
        self.objects_out = 0


def convert_source(source, rule, options, order_start=1):
    # type: (SourceObject, ClassRule, Options, int) -> Tuple[List[RoomObject], int, List[str]]
    """Convert one Vectorworks object. Returns (objects, regions_found, warnings)."""
    warnings = []  # type: List[str]
    if not source.triangles:
        return [], 0, warnings

    strategy = rule.strategy

    # BOX first: it is the only strategy that can produce a Shape=4, and when it applies
    # it is unambiguously the best answer — one object instead of six.
    if strategy in (STRATEGY_AUTO, STRATEGY_BOX):
        box = as_box(source.triangles)
        if box is not None:
            obj = RoomObject.from_box(source.name, box[0], box[1], rule.plane_type, order_start)
            if obj is not None:
                return [obj], 6, warnings
        if strategy == STRATEGY_BOX:
            warnings.append(
                '"{}" is not a box (its vertices are not the 8 corners of its bounding '
                "box), so every face was exported instead.".format(source.name)
            )
            strategy = STRATEGY_FACES

    mesh = weld(source.triangles)
    regions = find_coplanar_regions(mesh, options.angle_deg, options.offset_tol, options.min_area)
    if not regions:
        warnings.append('"{}" produced no usable surfaces.'.format(source.name))
        return [], 0, warnings

    found = len(regions)

    if strategy == STRATEGY_AUTO:
        strategy = STRATEGY_TOP if rule.plane_type in (PLANE_AUDIENCE, PLANE_STAGE) else STRATEGY_FACES

    if strategy == STRATEGY_TOP:
        horizontal = up_facing(regions)
        if not horizontal:
            warnings.append(
                '"{}" has no upward-facing surface, so every face was exported '
                "instead.".format(source.name)
            )
            chosen_list = regions
        else:
            chosen_list = [horizontal[0]]
            # Stepped seating is many horizontal regions at many heights, and there is
            # no single top face to pick. Taking the highest step silently would export
            # one row and lose the rest, so say so.
            others = [r for r in horizontal[1:] if abs(r.point[2] - horizontal[0].point[2]) > 0.15]
            if others:
                warnings.append(
                    '"{}" has {} horizontal surfaces at different heights — this looks '
                    "like stepped seating, and Top face exported only the highest. Use "
                    "All faces for this class, or model the rake as one sloped "
                    "surface.".format(source.name, len(others) + 1)
                )
    else:
        chosen_list = regions

    if options.max_objects_per_source > 0 and len(chosen_list) > options.max_objects_per_source:
        # Regions arrive largest-first, so this keeps the biggest surfaces.
        warnings.append(
            '"{}" was capped at {} objects ({} regions dropped).'.format(
                source.name, options.max_objects_per_source, len(chosen_list) - options.max_objects_per_source
            )
        )
        chosen_list = chosen_list[: options.max_objects_per_source]

    objects = []  # type: List[RoomObject]
    order = order_start
    for region in chosen_list:
        polygon = region_polygon(region, mesh, options.simplify_tol, rule.rectangle)
        if len(polygon) < 3:
            continue
        for face in fan_quads(polygon):
            obj = RoomObject.from_face(
                "{} {}".format(source.name, order), face, rule.plane_type, order
            )
            if obj is not None:
                objects.append(obj)
                order += 1

    if len(objects) == 1:
        objects[0].name = source.name

    return objects, found, warnings


def run(sources, rules, options=None, default_rule=None):
    # type: (Sequence[SourceObject], Dict[str, ClassRule], Optional[Options], Optional[ClassRule]) -> Result
    """Convert every source object according to its class rule."""
    options = options or Options()
    default_rule = default_rule or ClassRule()
    result = Result()
    group_order = 101

    for source in sources:
        rule = rules.get(source.class_name, default_rule)
        if not rule.include:
            continue

        result.sources_in += 1
        result.triangles_in += len(source.triangles) // 9

        objects, found, warnings = convert_source(source, rule, options)
        result.regions_found += found
        result.warnings.extend(warnings)
        if not objects:
            continue

        if len(objects) == 1:
            result.objects.append(objects[0])
        else:
            # A group of one is just noise in ArrayCalc's flat venue list.
            result.objects.append(RoomObject.group(source.name, group_order, objects))
            group_order += 1
        result.objects_out += len(objects)

    return result


def build_venue(result, project_name, author="ArrayCAD", source_note="Vectorworks"):
    # type: (Result, str, str, str) -> VenueFile
    return VenueFile(
        objects=result.objects,
        project_name=project_name,
        author=author,
        venue_comments="Converted from {} by ArrayCAD.".format(source_note),
    )


def to_xml(result, project_name, **kwargs):
    # type: (Result, str, object) -> str
    return write_dbacv(build_venue(result, project_name, **kwargs))
