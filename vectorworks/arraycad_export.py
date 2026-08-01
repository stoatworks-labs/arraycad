"""ArrayCAD — export a Vectorworks document as a d&b ArrayCalc venue (.dbacv).

RUN arraycad_probe.py FIRST. This exporter is written against Vectorworks API names
read out of the Vectorworks 2025 binary — the names are right, the exact signatures are
not verified outside Vectorworks. The probe tells you which calls work on your install,
and this script reports anything that failed rather than writing wrong geometry quietly.

Install as a Plug-in Command:
  Tools > Plug-ins > Plug-in Manager > New... > Command
  Name it "Export ArrayCalc Venue", then point its script at this file.
  Add it to your workspace with Tools > Workspaces > Edit Current Workspace.

Or paste it into Resource Manager > New Resource > Script > Python Script.

How to use it:
  1. Put your venue geometry on Vectorworks CLASSES that mean something — Seating,
     Stage, Walls, Ceiling, Rigging. The class is how this tool decides what each
     object IS, so the export is only as good as the classing.
  2. Select the objects you want, or leave nothing selected to offer every class.
  3. Run this command and set each class's plane type and strategy.

⚠️ The ArrayCalc plane types are REVERSE-ENGINEERED from one sample file, not from d&b
documentation. The numeric code is shown next to each name because that is what is
actually written to the file. Check a converted venue in ArrayCalc before trusting it.
"""

import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import vs
except ImportError:
    raise SystemExit("This script only runs inside Vectorworks.")

from arraycad import vwbridge
from arraycad.dbacv import (
    PLANE_AUDIENCE,
    PLANE_SOUNDSCAPE,
    PLANE_STAGE,
    PLANE_SURFACE,
    PLANE_TYPE_NAMES,
)
from arraycad.export import (
    STRATEGY_AUTO,
    STRATEGY_BOX,
    STRATEGY_FACES,
    STRATEGY_TOP,
    ClassRule,
    Options,
    SourceObject,
    run,
    to_xml,
)

# Class names that usually mean a given plane type. Only a starting guess — the dialog
# always shows what was chosen and lets it be changed.
CLASS_HINTS = (
    (("seat", "audience", "stall", "balcony", "tier", "circle", "gallery"), PLANE_AUDIENCE, STRATEGY_TOP),
    (("stage", "deck", "riser", "pros", "apron", "thrust"), PLANE_STAGE, STRATEGY_TOP),
    (("wall", "ceiling", "rail", "balustrade", "reflector", "soffit"), PLANE_SURFACE, STRATEGY_FACES),
    (("bridge", "truss", "rig", "bar", "beam", "column"), PLANE_SURFACE, STRATEGY_BOX),
    (("soundscape", "en-scene", "enscene"), PLANE_SOUNDSCAPE, STRATEGY_TOP),
)

SKIP_HINTS = ("dim", "text", "annot", "note", "grid", "sheet", "title", "north", "hidden")


def suggest(class_name):
    """(plane_type, strategy, include) for a class name."""
    low = (class_name or "").lower()
    for needle in SKIP_HINTS:
        if needle in low:
            return PLANE_SURFACE, STRATEGY_FACES, False
    for needles, plane_type, strategy in CLASS_HINTS:
        for needle in needles:
            if needle in low:
                return plane_type, strategy, True
    return PLANE_AUDIENCE, STRATEGY_AUTO, True


def collect(scale):
    """Gather every selected object (or everything, if nothing is selected)."""
    sources = []
    criteria = vwbridge.selected_criteria()
    if not vs.NumSelectedObjects():
        criteria = "(ALL)"

    def visit(h):
        info = vwbridge.object_info(h)
        # Try the direct read first; it is exact and does not touch the document.
        tris = vwbridge.object_triangles(h, scale)
        if not tris:
            # Extrudes, solids, walls and slabs need Vectorworks to tessellate them.
            tris = vwbridge.triangles_via_mesh_conversion(h, scale)
        if not tris:
            vwbridge.REPORT.skip("object with no readable geometry")
            return
        name = info["name"] or info["class"] or "Object {}".format(len(sources) + 1)
        sources.append(SourceObject(name, tris, info["class"] or "", info["layer"] or ""))

    vwbridge.each_object(criteria, visit)
    return sources


def ask_rules(class_names):
    """One dialog per class. Crude, but it needs no .vsm resource to install."""
    rules = {}
    plane_choices = [
        (PLANE_AUDIENCE, "Audience"),
        (PLANE_SURFACE, "Surface"),
        (PLANE_STAGE, "Stage"),
        (PLANE_SOUNDSCAPE, "Soundscape"),
    ]

    for name in class_names:
        plane_type, strategy, include = suggest(name)
        prompt = [
            'Class "{}"'.format(name),
            "",
            "Plane type — ⚠️ names are reverse-engineered, the number is what is written:",
        ]
        for i, (code, label) in enumerate(plane_choices):
            prompt.append("  {} = {} (PlaneType {})".format(i + 1, label, code))
        prompt.append("  0 = skip this class")
        prompt.append("")
        prompt.append("Suggested: {}".format(PLANE_TYPE_NAMES.get(plane_type, plane_type)))

        default = "0" if not include else str(
            [c for c, _ in plane_choices].index(plane_type) + 1
        )
        answer = vs.StrDialog("\n".join(prompt), default)
        if answer is None:
            return None  # cancelled
        try:
            choice = int(str(answer).strip())
        except ValueError:
            choice = 0
        if choice <= 0 or choice > len(plane_choices):
            rules[name] = ClassRule(include=False)
            continue

        chosen_plane = plane_choices[choice - 1][0]
        s_answer = vs.StrDialog(
            'Class "{}" — how should each object become planes?\n\n'
            "  1 = Auto (box if it is one, else top face, else all faces)\n"
            "  2 = Top face only (seating, stage decks)\n"
            "  3 = All faces (walls, ceilings, reflectors)\n"
            "  4 = Single box (lighting bridges, proscenium legs)\n"
            "  5 = Top face, squared off to a rectangle".format(name),
            {STRATEGY_AUTO: "1", STRATEGY_TOP: "2", STRATEGY_FACES: "3", STRATEGY_BOX: "4"}.get(
                strategy, "1"
            ),
        )
        if s_answer is None:
            return None
        smap = {
            "1": (STRATEGY_AUTO, False),
            "2": (STRATEGY_TOP, False),
            "3": (STRATEGY_FACES, False),
            "4": (STRATEGY_BOX, False),
            "5": (STRATEGY_TOP, True),
        }
        chosen_strategy, rectangle = smap.get(str(s_answer).strip(), (STRATEGY_AUTO, False))
        rules[name] = ClassRule(chosen_plane, chosen_strategy, rectangle, include=True)

    return rules


def main():
    scale = vwbridge.document_units_per_metre()

    vwbridge.message("ArrayCAD: reading geometry…")
    sources = collect(scale)
    vwbridge.message("")

    if not sources:
        vs.AlrtDialog(
            "ArrayCAD found no readable geometry.\n\n"
            + "\n".join(vwbridge.REPORT.lines()[:12])
            + "\n\nRun arraycad_probe.py and check the report."
        )
        return

    # Show the model size immediately: a wrong unit scale is the single most damaging
    # error this tool can make, and it is obvious the moment you see the numbers.
    xs, ys, zs = [], [], []
    for s in sources:
        for i in range(0, len(s.triangles), 3):
            xs.append(s.triangles[i])
            ys.append(s.triangles[i + 1])
            zs.append(s.triangles[i + 2])
    size = "Model size: {:.1f} x {:.1f} x {:.1f} m".format(
        max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
    )
    if not vs.YNDialog(
        "ArrayCAD read {} objects.\n\n{}\n\n"
        "Does that size look right? If not, cancel — the unit scale is wrong and every "
        "distance in the export would be wrong with it.".format(len(sources), size)
    ):
        return

    class_names = sorted(set(s.class_name for s in sources if s.class_name))
    if not class_names:
        class_names = [""]
    rules = ask_rules(class_names)
    if rules is None:
        return

    result = run(sources, rules, Options())
    if not result.objects:
        vs.AlrtDialog("Nothing was exported — every class was skipped, or no surfaces were found.")
        return

    doc_name = "Untitled"
    try:
        raw = vs.GetFName()
        if isinstance(raw, (tuple, list)):
            raw = raw[-1]
        doc_name = os.path.splitext(os.path.basename(str(raw)))[0] or "Untitled"
    except Exception:  # noqa: BLE001
        pass

    path = vwbridge.ask_save_path(doc_name + ".dbacv")
    if not path:
        return
    if not path.lower().endswith(".dbacv"):
        path += ".dbacv"

    xml = to_xml(result, doc_name, source_note="Vectorworks")
    if not vwbridge.write_text_file(path, xml):
        vs.AlrtDialog("Could not write the file:\n" + "\n".join(vwbridge.REPORT.lines()[:8]))
        return

    lines = [
        "ArrayCAD exported {} ArrayCalc objects.".format(result.objects_out),
        "",
        "From {} Vectorworks objects, {} triangles, {} flat regions.".format(
            result.sources_in, result.triangles_in, result.regions_found
        ),
        size,
        "",
        path,
    ]
    problems = vwbridge.REPORT.lines() + result.warnings
    if problems:
        lines.append("")
        lines.append("Notes:")
        lines.extend("  " + p for p in problems[:14])
        if len(problems) > 14:
            lines.append("  … and {} more.".format(len(problems) - 14))
    lines.append("")
    lines.append("⚠️ Plane types are reverse-engineered. Check the venue in ArrayCalc.")

    vs.AlrtDialog("\n".join(lines))


try:
    main()
except Exception:  # noqa: BLE001
    vs.AlrtDialog(
        "ArrayCAD failed:\n\n"
        + traceback.format_exc()[-1200:]
        + "\n\nRun arraycad_probe.py and send the report."
    )
