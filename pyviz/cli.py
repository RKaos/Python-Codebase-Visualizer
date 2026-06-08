"""CLI entry point: pyviz analyze | pyviz verify | pyviz diff."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import click

from pyviz import __version__
from pyviz.pipeline.p1_discovery import discover
from pyviz.pipeline.p2_parse import parse_all
from pyviz.pipeline.p3_resolve import build_resolver
from pyviz.pipeline.p4_edges import extract_static_graph
from pyviz.pipeline.p5_trace import run_runtime_trace
from pyviz.pipeline.p6_merge import merge
from pyviz.pipeline.p7_emit import emit


@click.group()
@click.version_option(__version__)
def main() -> None:
    """pyviz — Python codebase call/dependency graph visualizer."""


# ---------------------------------------------------------------------------
# analyze
# ---------------------------------------------------------------------------


@main.command()
@click.argument("path", type=click.Path(exists=True, file_okay=False, resolve_path=True))
@click.option("--source-root", default=None, help="Override auto-detected source root.")
@click.option("--out", "out_dir", default="pyviz-out", show_default=True, help="Output directory.")
@click.option(
    "--trace/--no-trace",
    default=False,
    show_default=True,
    help="Run runtime tracing via test suite.",
)
@click.option("--test-command", default="pytest -q", show_default=True)
@click.option(
    "--tracer",
    default="auto",
    type=click.Choice(["auto", "monitoring", "setprofile", "settrace"]),
    show_default=True,
)
@click.option("--include", "include_glob", default=None, help="Include glob filter on paths.")
@click.option("--exclude", "exclude_glob", default=None, help="Exclude glob filter on paths.")
def analyze(
    path: str,
    source_root: Optional[str],
    out_dir: str,
    trace: bool,
    test_command: str,
    tracer: str,
    include_glob: Optional[str],
    exclude_glob: Optional[str],
) -> None:
    """Analyze a Python codebase and emit graph.json to OUT_DIR."""
    t0 = time.perf_counter()
    repo_root = path

    click.echo(f"[pyviz] Analyzing {repo_root}")

    # P1 — Discovery
    click.echo("  P1 discovering modules...")
    module_map = discover(repo_root, source_root_override=source_root)
    click.echo(f"      found {len(module_map.modules)} modules in {module_map.source_roots}")

    # P2 — Parse
    click.echo("  P2 parsing symbol tables...")
    tables = parse_all(module_map)
    click.echo(f"      parsed {len(tables)} symbol tables")

    # P3 — Resolve
    click.echo("  P3 building re-export resolver...")
    resolver = build_resolver(tables)

    # P4 — Static edge extraction
    click.echo("  P4 extracting static edges...")
    static_graph = extract_static_graph(module_map, tables, resolver, repo_root)
    n_nodes = len(static_graph.nodes)
    n_edges = len(static_graph.edges)
    click.echo(f"      {n_nodes} nodes, {n_edges} edges")

    # P5 — Runtime tracing (optional)
    runtime_edges = []
    tracer_backend_used = "none"
    if trace:
        click.echo(f"  P5 runtime tracing ({test_command})...")
        try:
            runtime_edges = run_runtime_trace(
                repo_root, module_map, test_command=test_command, tracer_backend=tracer
            )
            tracer_backend_used = tracer if tracer != "auto" else _auto_backend()
            click.echo(f"      captured {len(runtime_edges)} runtime edges")
        except Exception as exc:
            click.echo(f"      WARNING: runtime tracing failed: {exc}", err=True)

    # P6 — Merge
    click.echo("  P6 merging...")
    merged_graph = merge(static_graph, runtime_edges, module_map, repo_root)

    # Invariant check (§5.3)
    n_init_bad = sum(
        1
        for e in merged_graph.edges
        if e.kind in ("imports", "defines")
        and merged_graph.nodes.get(e.target, None) is not None
        and merged_graph.nodes[e.target].file_path.endswith("__init__.py")
        and merged_graph.nodes[e.target].kind not in ("module", "package")
    )
    if n_init_bad > 0:
        click.echo(
            f"  WARNING: {n_init_bad} definition edges still target __init__.py — "
            "resolver bug (see §5.3)",
            err=True,
        )

    # P7 — Emit
    click.echo("  P7 emitting artifacts...")
    target_commit = _get_git_sha(repo_root)
    duration = time.perf_counter() - t0

    graph_path, manifest_path = emit(
        merged_graph,
        out_dir=os.path.join(repo_root, out_dir) if not os.path.isabs(out_dir) else out_dir,
        repo_root=repo_root,
        repo_info={
            "path": repo_root,
            "commit": target_commit,
            "source_roots": module_map.source_roots,
        },
        run_meta={
            "target_repo": repo_root,
            "target_commit": target_commit,
            "source_roots": module_map.source_roots,
            "tracer_backend": tracer_backend_used,
            "test_command": test_command if trace else "",
            "duration_s": round(duration, 2),
            "timestamp": _utc_now(),
        },
    )

    n_both = sum(1 for e in merged_graph.edges if e.provenance == "both")
    n_runtime_only = sum(1 for e in merged_graph.edges if e.provenance == "runtime")

    click.echo(f"\n[pyviz] Done in {duration:.1f}s")
    click.echo(f"  Nodes: {len(merged_graph.nodes)}  Edges: {len(merged_graph.edges)}")
    click.echo(f"  Provenance — static-only: {len(merged_graph.edges) - n_both - n_runtime_only}  "
               f"runtime-only: {n_runtime_only}  both: {n_both}")
    click.echo(f"  graph.json   -> {graph_path}")
    click.echo(f"  run-manifest -> {manifest_path}")

    if n_init_bad > 0:
        sys.exit(1)  # Non-zero exit for CI (§11)


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------


@main.command()
@click.argument("graph_path", type=click.Path(exists=True, resolve_path=True))
def verify(graph_path: str) -> None:
    """Verify graph.json invariants (§12.4)."""
    doc = json.loads(Path(graph_path).read_text(encoding="utf-8"))

    nodes = {n["id"]: n for n in doc["nodes"]}
    edges = doc["edges"]
    failures: list[str] = []

    # 1. §5.3 headline invariant
    n_init = doc["stats"].get("n_init_targeted_definition_edges", 0)
    if n_init > 0:
        failures.append(f"FAIL §5.3: {n_init} definition edges target __init__.py for non-package nodes")

    # 2. No dangling edges
    for e in edges:
        if e["source"] not in nodes:
            failures.append(f"FAIL dangling edge source {e['id']}: {e['source']} not in nodes")
        if e["target"] not in nodes:
            failures.append(f"FAIL dangling edge target {e['id']}: {e['target']} not in nodes")

    # 3. No resolved+runtime-only edge to a missing static node
    static_ids = {n["id"] for n in doc["nodes"] if n["kind"] != "external"}
    for e in edges:
        if (
            e.get("confidence") == "resolved"
            and e.get("provenance") == "runtime"
            and e["target"] not in static_ids
        ):
            failures.append(
                f"WARN runtime-only resolved edge {e['id']} targets non-static node {e['target']}"
            )

    if failures:
        for f in failures:
            click.echo(f, err=True)
        sys.exit(1)
    else:
        click.echo(f"[pyviz verify] All invariants pass for {graph_path}")


# ---------------------------------------------------------------------------
# diff (stretch feature)
# ---------------------------------------------------------------------------


@main.command()
@click.argument("graph_a", type=click.Path(exists=True, resolve_path=True))
@click.argument("graph_b", type=click.Path(exists=True, resolve_path=True))
def diff(graph_a: str, graph_b: str) -> None:
    """Structural diff between two graph.json artifacts."""
    a = json.loads(Path(graph_a).read_text(encoding="utf-8"))
    b = json.loads(Path(graph_b).read_text(encoding="utf-8"))

    ids_a = {n["id"] for n in a["nodes"]}
    ids_b = {n["id"] for n in b["nodes"]}
    added_nodes = ids_b - ids_a
    removed_nodes = ids_a - ids_b

    eids_a = {e["id"] for e in a["edges"]}
    eids_b = {e["id"] for e in b["edges"]}
    added_edges = eids_b - eids_a
    removed_edges = eids_a - eids_b

    click.echo(f"Nodes added:   {len(added_nodes)}")
    click.echo(f"Nodes removed: {len(removed_nodes)}")
    click.echo(f"Edges added:   {len(added_edges)}")
    click.echo(f"Edges removed: {len(removed_edges)}")

    if added_nodes:
        click.echo("\nAdded nodes:")
        node_map_b = {n["id"]: n for n in b["nodes"]}
        for nid in sorted(added_nodes)[:20]:
            n = node_map_b[nid]
            click.echo(f"  + {n['kind']:10} {n['module']}::{n['qualname']}")

    if removed_nodes:
        click.echo("\nRemoved nodes:")
        node_map_a = {n["id"]: n for n in a["nodes"]}
        for nid in sorted(removed_nodes)[:20]:
            n = node_map_a[nid]
            click.echo(f"  - {n['kind']:10} {n['module']}::{n['qualname']}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_git_sha(repo_root: str) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip()[:12] if result.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def _auto_backend() -> str:
    return "sys.monitoring" if sys.version_info >= (3, 12) else "sys.setprofile"


def _utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
