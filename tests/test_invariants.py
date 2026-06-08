"""Integration tests: run full pipeline over fixtures and verify invariants.

§12.4 — automated invariants checked in CI on every commit.
§5.3  — no import/defines edge may target __init__.py for a non-package definition.
"""
import json
import os
import tempfile
from pathlib import Path

import pytest

from pyviz.pipeline.p1_discovery import discover
from pyviz.pipeline.p2_parse import parse_all
from pyviz.pipeline.p3_resolve import build_resolver
from pyviz.pipeline.p4_edges import extract_static_graph
from pyviz.pipeline.p6_merge import merge
from pyviz.pipeline.p7_emit import emit

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


def run_pipeline(fixture_name: str):
    fixture_path = str(FIXTURES_DIR / fixture_name)
    module_map = discover(fixture_path)
    tables = parse_all(module_map)
    resolver = build_resolver(tables)
    graph = extract_static_graph(module_map, tables, resolver, fixture_path)
    merged = merge(graph, [], module_map, fixture_path)
    return merged, module_map, tables, resolver


class TestInitTargetingInvariant:
    """§5.3: no definition-targeted edge may point at __init__.py for non-package nodes."""

    def _assert_no_init_targeted_definition_edges(self, graph, fixture_name):
        violations = []
        for edge in graph.edges:
            if edge.kind not in ("imports",):
                continue
            tgt = graph.nodes.get(edge.target)
            if tgt and tgt.file_path.endswith("__init__.py") and tgt.kind not in ("module", "package"):
                violations.append(
                    f"Edge {edge.id}: {edge.kind} targets {tgt.file_path}::{tgt.qualname} "
                    f"(kind={tgt.kind}) — should point to the definition site, not __init__"
                )
        assert not violations, (
            f"§5.3 violation in fixture '{fixture_name}':\n" + "\n".join(violations)
        )

    def test_reexport_chain(self):
        graph, *_ = run_pipeline("reexport_chain")
        self._assert_no_init_targeted_definition_edges(graph, "reexport_chain")

    def test_wildcard(self):
        graph, *_ = run_pipeline("wildcard")
        self._assert_no_init_targeted_definition_edges(graph, "wildcard")

    def test_decorators(self):
        graph, *_ = run_pipeline("decorators")
        self._assert_no_init_targeted_definition_edges(graph, "decorators")


class TestReexportChainFixture:
    def setup_method(self):
        self.graph, self.module_map, self.tables, self.resolver = run_pipeline("reexport_chain")

    def test_thing_import_targets_core_not_init(self):
        """The golden fixture assertion: from pkg import Thing → pkg.core.Thing."""
        res = self.resolver.resolve("pkg", "Thing")
        assert res.status == "resolved"
        assert res.def_module == "pkg.core", (
            f"Expected pkg.core, got {res.def_module}"
        )
        assert res.def_qualname == "Thing"

    def test_no_dangling_edges(self):
        node_ids = set(self.graph.nodes)
        for e in self.graph.edges:
            assert e.source in node_ids, f"Dangling edge source: {e.source}"
            assert e.target in node_ids, f"Dangling edge target: {e.target}"

    def test_thing_node_exists_in_core(self):
        """There must be a node for Thing in pkg/core.py."""
        thing_nodes = [
            n for n in self.graph.nodes.values()
            if n.qualname == "Thing" and "core" in n.file_path
        ]
        assert thing_nodes, "No node for pkg.core.Thing found"


class TestWildcardFixture:
    def setup_method(self):
        self.graph, self.module_map, self.tables, self.resolver = run_pipeline("wildcard")

    def test_widget_resolves_to_core(self):
        res = self.resolver.resolve("pkg", "Widget")
        assert res.status == "resolved"
        assert res.def_module == "pkg.core"

    def test_internal_not_exported(self):
        res = self.resolver.resolve("pkg", "_internal")
        assert res.status == "unresolved"

    def test_dynamic_all_fixture(self):
        _, _, tables, resolver = run_pipeline("dynamic_all")
        core_st = tables.get("pkg.core")
        assert core_st is not None
        assert core_st.all_is_dynamic is True


class TestCycleFixture:
    def test_cycle_terminates(self):
        """Pipeline must complete; cycle must not cause infinite recursion."""
        graph, module_map, tables, resolver = run_pipeline("cycle")
        res = resolver.resolve("pkg", "X")
        # Should be either resolved (found in pkg.b) or cycle — never hangs
        assert res.status in ("resolved", "cycle", "unresolved")

    def test_no_dangling_edges_in_cycle(self):
        graph, *_ = run_pipeline("cycle")
        node_ids = set(graph.nodes)
        for e in graph.edges:
            assert e.source in node_ids
            assert e.target in node_ids


class TestGraphInvariants:
    """§12.4: automated invariants that must hold on every graph."""

    @pytest.mark.parametrize("fixture", [
        "reexport_chain", "wildcard", "cycle", "decorators", "getattr_dispatch", "dynamic_all"
    ])
    def test_no_dangling_edges(self, fixture):
        graph, *_ = run_pipeline(fixture)
        node_ids = set(graph.nodes)
        for e in graph.edges:
            assert e.source in node_ids, f"[{fixture}] dangling source in edge {e.id}"
            assert e.target in node_ids, f"[{fixture}] dangling target in edge {e.id}"

    @pytest.mark.parametrize("fixture", [
        "reexport_chain", "wildcard", "cycle", "decorators", "getattr_dispatch", "dynamic_all"
    ])
    def test_determinism(self, fixture):
        """Two pipeline runs over same fixture produce identical node/edge id sets."""
        g1, *_ = run_pipeline(fixture)
        g2, *_ = run_pipeline(fixture)
        assert set(g1.nodes) == set(g2.nodes), f"[{fixture}] non-deterministic nodes"
        assert {e.id for e in g1.edges} == {e.id for e in g2.edges}, \
            f"[{fixture}] non-deterministic edges"

    @pytest.mark.parametrize("fixture", [
        "reexport_chain", "wildcard", "decorators",
    ])
    def test_init_targeting_invariant(self, fixture):
        graph, *_ = run_pipeline(fixture)
        violations = [
            (e.id, graph.nodes[e.target].file_path)
            for e in graph.edges
            if e.kind == "imports"
            and e.target in graph.nodes
            and graph.nodes[e.target].file_path.endswith("__init__.py")
            and graph.nodes[e.target].kind not in ("module", "package")
        ]
        assert not violations, (
            f"[{fixture}] §5.3 init-targeting violations: {violations}"
        )
