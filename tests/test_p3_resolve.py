"""Tests for P3 — the re-export resolver.

These are unit tests over hand-built SymbolTables; no filesystem access required.
Golden assertion: from pkg import Thing resolves to pkg.core, NOT pkg.__init__.
"""
import pytest
from pyviz.models import Binding, Definition, SymbolTable
from pyviz.pipeline.p3_resolve import build_resolver


def _make_tables():
    """Build SymbolTables matching the reexport_chain fixture."""
    # pkg.core defines Thing and helper
    core = SymbolTable(module_name="pkg.core", file_path="pkg/core.py")
    core.definitions["Thing"] = Definition(qualname="Thing", kind="class", lineno=4, end_lineno=10)
    core.definitions["helper"] = Definition(qualname="helper", kind="function", lineno=13, end_lineno=14)

    # pkg.__init__ re-exports both from core
    init = SymbolTable(module_name="pkg", file_path="pkg/__init__.py")
    init.bindings["Thing"] = Binding(
        local_name="Thing", target_module="pkg.core", original_name="Thing"
    )
    init.bindings["helper"] = Binding(
        local_name="helper", target_module="pkg.core", original_name="helper"
    )

    return {"pkg": init, "pkg.core": core}


class TestReexportChain:
    def setup_method(self):
        self.tables = _make_tables()
        self.resolver = build_resolver(self.tables)

    def test_thing_resolves_to_core_not_init(self):
        """Golden invariant: import from pkg must resolve to pkg.core."""
        res = self.resolver.resolve("pkg", "Thing")
        assert res.status == "resolved"
        assert res.def_module == "pkg.core", (
            f"Expected pkg.core, got {res.def_module}. "
            "This is the §5.3 invariant violation — edge targeting __init__ for non-init definition."
        )
        assert res.def_qualname == "Thing"

    def test_helper_resolves_to_core(self):
        res = self.resolver.resolve("pkg", "helper")
        assert res.status == "resolved"
        assert res.def_module == "pkg.core"

    def test_direct_lookup_in_core(self):
        res = self.resolver.resolve("pkg.core", "Thing")
        assert res.status == "resolved"
        assert res.def_module == "pkg.core"

    def test_unknown_name_unresolved(self):
        res = self.resolver.resolve("pkg", "NoSuchThing")
        assert res.status == "unresolved"

    def test_memoization(self):
        r1 = self.resolver.resolve("pkg", "Thing")
        r2 = self.resolver.resolve("pkg", "Thing")
        assert r1 is r2  # same object from memo


class TestWildcard:
    def setup_method(self):
        core = SymbolTable(module_name="pkg.core", file_path="pkg/core.py")
        core.definitions["Widget"] = Definition(qualname="Widget", kind="class", lineno=7, end_lineno=8)
        core.definitions["_internal"] = Definition(qualname="_internal", kind="function", lineno=11, end_lineno=12)
        core.all_names = frozenset(["Widget"])

        init = SymbolTable(module_name="pkg", file_path="pkg/__init__.py")
        init.wildcard_sources = ["pkg.core"]

        self.tables = {"pkg": init, "pkg.core": core}
        self.resolver = build_resolver(self.tables)

    def test_widget_resolves_through_wildcard(self):
        res = self.resolver.resolve("pkg", "Widget")
        assert res.status == "resolved"
        assert res.def_module == "pkg.core"

    def test_internal_not_exported(self):
        """_internal not in __all__ — should not resolve through wildcard."""
        res = self.resolver.resolve("pkg", "_internal")
        assert res.status == "unresolved"


class TestCycle:
    def setup_method(self):
        a = SymbolTable(module_name="pkg.a", file_path="pkg/a.py")
        a.bindings["X"] = Binding(local_name="X", target_module="pkg.b", original_name="X")

        b = SymbolTable(module_name="pkg.b", file_path="pkg/b.py")
        b.bindings["X"] = Binding(local_name="X", target_module="pkg.a", original_name="X")
        # X is also defined in b
        b.definitions["X"] = Definition(qualname="X", kind="class", lineno=3, end_lineno=4)

        self.tables = {"pkg.a": a, "pkg.b": b}
        self.resolver = build_resolver(self.tables)

    def test_cycle_terminates(self):
        """Cycle detection must terminate and return status='cycle'."""
        # pkg.a.X -> pkg.b.X -> pkg.a.X (cycle)
        # But pkg.b actually defines X, so pkg.b.X resolves fine
        res_b = self.resolver.resolve("pkg.b", "X")
        assert res_b.status == "resolved"

        # From pkg.a, following to pkg.b.X: that's defined, so should resolve
        res_a = self.resolver.resolve("pkg.a", "X")
        assert res_a.status == "resolved"  # finds it at pkg.b.X

    def test_pure_cycle_returns_cycle_status(self):
        """A genuine cycle (no definition) returns status='cycle'."""
        # Make b's X also a pure re-export back to a
        self.tables["pkg.b"].definitions.clear()
        self.resolver = build_resolver(self.tables)
        res = self.resolver.resolve("pkg.a", "X")
        assert res.status == "cycle"


class TestModuleImport:
    def test_bare_module_import_resolves_module(self):
        core = SymbolTable(module_name="pkg.core", file_path="pkg/core.py")
        core.definitions["Thing"] = Definition(qualname="Thing", kind="class", lineno=1, end_lineno=5)

        user = SymbolTable(module_name="user", file_path="user.py")
        user.bindings["core"] = Binding(
            local_name="core", target_module="pkg.core", original_name=None, is_module_import=True
        )

        tables = {"pkg.core": core, "user": user}
        resolver = build_resolver(tables)

        res = resolver.resolve("user", "core")
        assert res.status == "resolved-module"
        assert res.def_module == "pkg.core"
