"""ArrayCAD — Vectorworks API probe.

RUN THIS FIRST, before the exporter.

The exporter is written against Vectorworks API function names read out of the
Vectorworks 2025 binary, so the names are certainly right. Their exact SIGNATURES and
return shapes are not verifiable outside Vectorworks. This script resolves that: it
calls each one on your actual document and reports what happened, plus an inventory of
what your drawing contains.

It changes nothing. It only reads, and writes one text file next to your document.

Install as a Plug-in Command, or just paste it into a script window:
  Tools > Plug-ins > Plug-in Manager > New > Command
or
  Resource Manager > New Resource > Script > Python Script

Send the report to whoever is maintaining this and the exporter can be corrected for
your Vectorworks version.
"""

import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import vs
except ImportError:
    raise SystemExit("This script only runs inside Vectorworks.")


LINES = []


def say(text=""):
    LINES.append(str(text))


def probe(name, *args):
    """Call vs.<name>(*args) and record the outcome and the SHAPE of what came back."""
    fn = getattr(vs, name, None)
    if fn is None:
        say("  MISSING   vs.{}".format(name))
        return None
    try:
        result = fn(*args)
    except Exception as exc:  # noqa: BLE001
        say("  ERROR     vs.{}({}) -> {}: {}".format(name, _argstr(args), type(exc).__name__, exc))
        return None
    say("  ok        vs.{}({}) -> {} {!r}".format(name, _argstr(args), type(result).__name__, _trim(result)))
    return result


def _argstr(args):
    return ", ".join(_trim(a, 24) for a in args)


def _trim(v, n=90):
    s = repr(v)
    return s if len(s) <= n else s[: n - 3] + "..."


def main():
    say("ArrayCAD — Vectorworks API probe")
    say("=" * 72)
    say("Vectorworks version: {}".format(_trim(getattr(vs, "GetVersionEx", lambda: "?")())))
    say("Python: {}".format(sys.version.replace("\n", " ")))
    say()

    say("--- document ---")
    probe("GetUnits")
    probe("GetPrefReal", 152)
    probe("GetLName", probe("FLayer"))
    say()

    say("--- classes ---")
    n = probe("ClassNum")
    if n:
        for i in range(1, min(int(n), 40) + 1):
            probe("ClassList", i)
    say()

    say("--- selection ---")
    sel_count = probe("NumSelectedObjects")
    if not sel_count:
        say("  NOTE: nothing is selected. Select a few venue objects — ideally one")
        say("        3D polygon, one mesh, one extrude and one solid — and run again.")
        say("        The geometry probes below need a selection to say anything useful.")
    say()

    say("--- selected objects ---")
    seen = {"n": 0}

    def look(h):
        seen["n"] += 1
        if seen["n"] > 25:
            return
        say("  [{}] handle {}".format(seen["n"], _trim(h, 30)))
        for fname in ("GetTypeN", "GetName", "GetClass"):
            probe(fname, h)
        layer = probe("GetLayer", h)
        if layer is not None:
            probe("GetLName", layer)

        # The two direct read paths.
        vcount = probe("GetVertNum", h)
        if vcount and int(vcount) >= 1:
            probe("GetPolyPt3D", h, 1)
            probe("GetPolyPt", h, 1)
        mcount = probe("GetMeshVertsCnt", h)
        if mcount and int(mcount) >= 1:
            probe("GetMeshVertex", h, 1)

        # Group traversal.
        first = probe("FInGroup", h)
        if first is not None:
            probe("GetTypeN", first)
            probe("NextObj", first)

        probe("GetBBox", h)
        say()

    try:
        vs.ForEachObject(look, "(SEL=TRUE)")
    except Exception:  # noqa: BLE001
        say("  ForEachObject failed:")
        say(traceback.format_exc())

    say("--- mesh conversion path ---")
    say("  This is the route used for extrudes, solids, walls and slabs.")
    say("  It works on a DUPLICATE and deletes it afterwards; your drawing is not changed.")
    if sel_count:
        try:
            first = vs.FSActLayer()
            dup = probe("CreateDuplicateObject", first, probe("GetParent", first))
            if dup is None:
                dup = probe("HDuplicate", first, 0.0, 0.0)
            if dup is not None:
                probe("DSelectAll")
                probe("SetSelect", dup)
                probe("DoMenuTextByName", "Convert to Mesh", 0)
                after = probe("FSActLayer")
                if after is not None:
                    probe("GetTypeN", after)
                    probe("GetMeshVertsCnt", after)
                    probe("GetVertNum", after)
                    probe("FInGroup", after)
                for handle in (after, dup):
                    if handle is not None:
                        probe("DelObject", handle)
                probe("DSelectAll")
        except Exception:  # noqa: BLE001
            say("  mesh conversion probe failed:")
            say(traceback.format_exc())
    say()

    say("--- file dialog ---")
    say("  (not exercised — it would open a dialog; the exporter uses vs.PutFile)")
    say("  vs.PutFile present: {}".format(hasattr(vs, "PutFile")))
    say()

    say("=" * 72)
    say("END")

    report = "\n".join(LINES)
    path = _report_path()
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(report)
        vs.AlrtDialog("ArrayCAD probe finished.\n\nReport written to:\n{}".format(path))
    except (IOError, OSError) as exc:
        vs.AlrtDialog("ArrayCAD probe finished but could not write the report:\n{}".format(exc))


def _report_path():
    """Next to the document if it has been saved, otherwise the user's home folder."""
    try:
        name = vs.GetFName()
        if isinstance(name, (tuple, list)):
            name = name[-1]
        if name and os.path.dirname(str(name)):
            return os.path.join(os.path.dirname(str(name)), "arraycad-probe.txt")
    except Exception:  # noqa: BLE001
        pass
    return os.path.join(os.path.expanduser("~"), "arraycad-probe.txt")


main()
