"""P7 — Emit graph.json and run-manifest.json.

The artifact is the contract between the analysis core and the web viewer.
Nodes and edges are sorted by id for byte-identical output across runs (§12.4).
"""
from __future__ import annotations

import dataclasses
import json
import sys
import time
from pathlib import Path
from typing import Any

from pyviz.models import GraphEdge, GraphNode, StaticGraph

SCHEMA_VERSION = "1.0"


def emit(
    graph: StaticGraph,
    out_dir: str,
    repo_root: str,
    repo_info: dict,
    run_meta: dict,
) -> tuple[str, str]:
    """Write graph.json and run-manifest.json; return their paths."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    graph_doc = _build_graph_doc(graph, repo_info)
    manifest = _build_manifest(run_meta, graph_doc["stats"])

    graph_path = out / "graph.json"
    manifest_path = out / "run-manifest.json"

    graph_path.write_text(json.dumps(graph_doc, indent=2), encoding="utf-8")
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return str(graph_path), str(manifest_path)


def _build_graph_doc(graph: StaticGraph, repo_info: dict) -> dict:
    nodes_sorted = sorted(graph.nodes.values(), key=lambda n: n.id)
    edges_sorted = sorted(graph.edges, key=lambda e: e.id)

    stats = _compute_stats(graph)

    return {
        "schema_version": SCHEMA_VERSION,
        "repo": repo_info,
        "nodes": [_node_to_dict(n) for n in nodes_sorted],
        "edges": [_edge_to_dict(e) for e in edges_sorted],
        "stats": stats,
        "global_caveats": [
            "runtime edges are bounded by the test suite's coverage",
            "dynamic dispatch (getattr, callbacks, higher-order) is best-effort; "
            "absent static edges may be recovered as runtime-only edges",
        ],
    }


def _compute_stats(graph: StaticGraph) -> dict:
    kinds: dict[str, int] = {}
    for n in graph.nodes.values():
        kinds[n.kind] = kinds.get(n.kind, 0) + 1

    n_static = sum(1 for e in graph.edges if e.provenance == "static")
    n_runtime = sum(1 for e in graph.edges if e.provenance == "runtime")
    n_both = sum(1 for e in graph.edges if e.provenance == "both")

    # §5.3 headline invariant: count edges to __init__.py that are definition edges
    n_init_targeted = _count_init_targeted_definition_edges(graph)

    return {
        "n_nodes": len(graph.nodes),
        "n_modules": kinds.get("module", 0) + kinds.get("package", 0),
        "n_classes": kinds.get("class", 0),
        "n_functions": kinds.get("function", 0) + kinds.get("method", 0) + kinds.get("coroutine", 0),
        "n_edges": len(graph.edges),
        "n_calls_static": n_static,
        "n_calls_runtime": n_runtime,
        "n_calls_both": n_both,
        "n_init_targeted_definition_edges": n_init_targeted,
        "node_kinds": kinds,
    }


def _count_init_targeted_definition_edges(graph: StaticGraph) -> int:
    """Count definition/import edges that incorrectly target an __init__.py."""
    count = 0
    for edge in graph.edges:
        if edge.kind not in ("imports", "defines"):
            continue
        tgt = graph.nodes.get(edge.target)
        if tgt and tgt.file_path.endswith("__init__.py"):
            # This is a bug if the target is a non-package definition
            if tgt.kind not in ("module", "package"):
                count += 1
    return count


def _node_to_dict(n: GraphNode) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "name": n.name,
        "qualname": n.qualname,
        "module": n.module,
        "file_path": n.file_path,
        "line_start": n.line_start,
        "line_end": n.line_end,
        "attributes": n.attributes,
        "caveats": n.caveats,
    }


def _edge_to_dict(e: GraphEdge) -> dict:
    return {
        "id": e.id,
        "source": e.source,
        "target": e.target,
        "kind": e.kind,
        "provenance": e.provenance,
        "confidence": e.confidence,
        "evidence": e.evidence,
        "caveats": e.caveats,
    }


def _build_manifest(run_meta: dict, stats: dict) -> dict:
    return {
        "tool_version": "0.1.0",
        "schema_version": SCHEMA_VERSION,
        "python_version": sys.version,
        "timestamp": run_meta.get("timestamp", ""),
        "target_repo": run_meta.get("target_repo", ""),
        "target_commit": run_meta.get("target_commit", "unknown"),
        "source_roots": run_meta.get("source_roots", []),
        "tracer_backend": run_meta.get("tracer_backend", "none"),
        "test_command": run_meta.get("test_command", ""),
        "duration_s": run_meta.get("duration_s", 0.0),
        "stats": stats,
    }
