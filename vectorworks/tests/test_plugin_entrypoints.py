"""The plug-in entry points must at least IMPORT.

`arraycad_export.py` and `arraycad_probe.py` only ever run inside Vectorworks, so nothing
else in this repo exercises them — and that is exactly how they rot. A rename of the
PlaneType constants once left `arraycad_export.py` importing names that no longer existed;
nothing caught it, because the only thing that would have is a Vectorworks session.

These tests stub out `vs` and import both files with their top-level `main()` call
suppressed. That will not prove the Vectorworks API calls are right — nothing here can —
but it does prove the modules parse, their imports resolve, and their pure decision logic
still works.
"""

import ast
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
VW = os.path.join(HERE, "..")
sys.path.insert(0, VW)


def fake_vs():
    """A `vs` module that answers everything with None."""
    mod = types.ModuleType("vs")

    def anything(*_args, **_kwargs):
        return None

    class _Any(object):
        def __getattr__(self, _name):
            return anything

    mod.__getattr__ = lambda _name: anything  # type: ignore[attr-defined]
    for name in (
        "AlrtDialog Message StrDialog YNDialog NumSelectedObjects ForEachObject GetFName "
        "FSActLayer GetVersionEx PutFile DSelectAll SetSelect DoMenuTextByName DelObject "
        "GetParent CreateDuplicateObject HDuplicate GetUnits GetPrefReal FLayer ClassNum "
        "ClassList GetLName GetLayer GetName GetClass GetTypeN GetVertNum GetPolyPt3D "
        "GetPolyPt GetMeshVertsCnt GetMeshVertex FInGroup NextObj GetBBox SelectObj"
    ).split():
        setattr(mod, name, anything)
    return mod


def load_without_running(filename):
    """Exec a plug-in script with its top-level `main()` invocation removed.

    Both scripts call main() at import, which is how a Vectorworks Plug-in Command works.
    The call is stripped by parsing the module and dropping top-level statements that are
    not definitions or imports — a good deal safer than string surgery on the source.
    """
    path = os.path.join(VW, filename)
    with open(path, "r", encoding="utf-8") as fh:
        tree = ast.parse(fh.read(), filename)

    keep = []
    for node in tree.body:
        if isinstance(
            node,
            (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef, ast.Assign, ast.AnnAssign),
        ):
            keep.append(node)
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            # The module docstring. `ast.Str` is gone in 3.12+ and `ast.Constant` has
            # covered strings since 3.8, so this works on the local interpreter and on
            # the 3.9 that Vectorworks bundles.
            keep.append(node)
        elif isinstance(node, ast.Try):
            # `try: import vs` at the top is an import; `try: main()` at the bottom is not.
            if any(isinstance(n, (ast.Import, ast.ImportFrom)) for n in node.body):
                keep.append(node)

    tree.body = keep
    ast.fix_missing_locations(tree)
    ns = {"__name__": "plugin_under_test", "__file__": path}
    exec(compile(tree, filename, "exec"), ns)  # noqa: S102
    return ns


class TestEntryPoints(unittest.TestCase):
    def setUp(self):
        sys.modules["vs"] = fake_vs()

    def tearDown(self):
        sys.modules.pop("vs", None)
        for mod in [m for m in sys.modules if m.startswith("arraycad")]:
            sys.modules.pop(mod, None)

    def test_exporter_imports(self):
        ns = load_without_running("arraycad_export.py")
        self.assertIn("main", ns)
        self.assertIn("CLASS_HINTS", ns)
        self.assertIn("suggest", ns)

    def test_probe_imports(self):
        ns = load_without_running("arraycad_probe.py")
        self.assertIn("probe", ns)
        self.assertIn("main", ns)

    def test_class_name_suggestions(self):
        from arraycad.dbacv import (
            PLANE_LISTENING,
            PLANE_POSITIONING,
            PLANE_STAGE,
            PLANE_SURFACE,
        )

        suggest = load_without_running("arraycad_export.py")["suggest"]

        for name, expected in [
            ("Seating - Stalls", PLANE_LISTENING),
            ("Balcony Tier 2", PLANE_LISTENING),
            ("Stage Deck", PLANE_STAGE),
            ("Walls - Side", PLANE_SURFACE),
            ("Ceiling Reflectors", PLANE_SURFACE),
            ("Soundscape zone", PLANE_POSITIONING),
        ]:
            plane_type, _strategy, include = suggest(name)
            self.assertEqual(plane_type, expected, "for class {!r}".format(name))
            self.assertTrue(include, "for class {!r}".format(name))

    def test_annotation_classes_are_skipped(self):
        suggest = load_without_running("arraycad_export.py")["suggest"]
        for name in ["Dimensions", "Text - notes", "Grid lines", "Sheet border", "North arrow"]:
            _plane, _strategy, include = suggest(name)
            self.assertFalse(include, "expected {!r} to be skipped".format(name))

    def test_every_suggested_plane_type_is_a_real_code(self):
        from arraycad.dbacv import PLANE_TYPE_NAMES

        ns = load_without_running("arraycad_export.py")
        for _needles, plane_type, _strategy in ns["CLASS_HINTS"]:
            self.assertIn(plane_type, PLANE_TYPE_NAMES)

    def test_every_suggested_strategy_is_a_real_strategy(self):
        from arraycad.export import STRATEGIES

        ns = load_without_running("arraycad_export.py")
        for _needles, _plane_type, strategy in ns["CLASS_HINTS"]:
            self.assertIn(strategy, STRATEGIES)

    def test_the_dialog_offers_only_real_plane_types(self):
        # ask_rules builds its menu from a hardcoded list; if that drifts from the real
        # codes the user picks a plane type that does not exist.
        from arraycad.dbacv import PLANE_TYPE_NAMES

        with open(os.path.join(VW, "arraycad_export.py"), "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id.startswith("PLANE_"):
                names.add(node.id)

        from arraycad import dbacv

        for name in names:
            if name == "PLANE_TYPE_NAMES":
                continue
            self.assertTrue(hasattr(dbacv, name), "arraycad_export.py uses missing {}".format(name))
            self.assertIn(getattr(dbacv, name), PLANE_TYPE_NAMES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
