"""P6 — Merge static graph with runtime call edges.

Three outcome buckets per (source, target, 'calls') triple (per TRD §9.1):
  both          — corroborated; highest trust.
  static-only   — provable structural call, tests didn't exercise it.
  runtime-only  — dynamic dispatch: static missed it (expected) or resolver bug.

Runtime-only edges are ground-truth for existence; they get confidence='resolved'.
"""
from __future__ import annotations

import os
from pathlib import Path

from pyviz.models import (
    GraphEdge,
    GraphNode,
    ModuleMap,
    RuntimeEdge,
    StaticGraph,
    make_edge_id,
    make_node_id,
)


def merge(
    static_graph: StaticGraph,
    runtime_edges: list[RuntimeEdge],
    module_map: ModuleMap,
    repo_root: str,
) -> StaticGraph:
    """Merge runtime edges into the static graph. Returns a new StaticGraph."""
    merged_nodes = dict(static_graph.nodes)
    merged_edges = list(static_graph.edges)

    # Build a fast lookup: edge_id → index in merged_edges
    edge_index: dict[str, int] = {e.id: i for i, e in enumerate(merged_edges)}

    for rt in runtime_edges:
        caller_id = _runtime_node_id(rt.caller_relpath, rt.caller_qualname, merged_nodes)
        callee_id = _runtime_node_id(rt.callee_relpath, rt.callee_qualname, merged_nodes)

        # If either endpoint is not in the static graph, create external nodes
        if caller_id is None:
            caller_id = _ensure_external_node(rt.caller_relpath, rt.caller_qualname, merged_nodes)
        if callee_id is None:
            callee_id = _ensure_external_node(rt.callee_relpath, rt.callee_qualname, merged_nodes)

        edge_kind = "calls"
        eid = make_edge_id(caller_id, callee_id, edge_kind)
        rt_evidence = {"call_count": rt.count}

        if eid in edge_index:
            # Already exists as static edge → upgrade to "both"
            existing = merged_edges[edge_index[eid]]
            existing.provenance = "both"
            existing.evidence["runtime"] = rt_evidence
        else:
            # Runtime-only edge: dynamic dispatch that static missed
            new_edge = GraphEdge(
                id=eid,
                source=caller_id,
                target=callee_id,
                kind=edge_kind,
                provenance="runtime",
                confidence="resolved",  # runtime is ground truth for existence
                evidence={"runtime": rt_evidence},
                caveats=["runtime-only: dynamic dispatch not resolved statically"],
            )
            merged_edges.append(new_edge)
            edge_index[eid] = len(merged_edges) - 1

    return StaticGraph(nodes=merged_nodes, edges=merged_edges)


# ---------------------------------------------------------------------------
# Node identity helpers for the runtime side
# ---------------------------------------------------------------------------


def _runtime_node_id(
    relpath: str, qualname: str, nodes: dict[str, GraphNode]
) -> str | None:
    """Find a static graph node matching (relpath, qualname) regardless of kind."""
    # Try common kinds in priority order
    for kind in ("method", "coroutine", "function", "class", "module", "package", "variable"):
        nid = make_node_id(kind, relpath, qualname)
        if nid in nodes:
            return nid
    # Also try with empty qualname (module node)
    nid = make_node_id("module", relpath, "")
    if nid in nodes:
        return nid
    nid = make_node_id("package", relpath, "")
    if nid in nodes:
        return nid
    return None


def _ensure_external_node(
    relpath: str, qualname: str, nodes: dict[str, GraphNode]
) -> str:
    """Create an external node for a runtime frame not in the static graph."""
    nid = make_node_id("external", relpath, qualname)
    if nid not in nodes:
        name = qualname.split(".")[-1] if qualname else relpath.split("/")[-1]
        nodes[nid] = GraphNode(
            id=nid,
            kind="external",
            name=name,
            qualname=qualname,
            module=relpath,
            file_path=relpath,
            line_start=0,
            line_end=0,
            attributes={},
            caveats=["runtime-only node: not found in static analysis"],
        )
    return nid
