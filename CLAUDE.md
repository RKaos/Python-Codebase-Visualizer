# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup

```bash
pip install -e ".[dev]"                               # installs pyviz CLI + pytest
cd viewer && npm install --legacy-peer-deps           # --legacy-peer-deps is required; plain npm install fails
```

## Common Commands

```bash
# Analyze a Python project and emit graph.json
pyviz analyze <path/to/project> --out pyviz-out

# Analyze with runtime tracing (runs the project's test suite)
pyviz analyze <path/to/project> --trace --out pyviz-out

# Verify graph.json invariants
pyviz verify pyviz-out/graph.json

# Diff two graph snapshots
pyviz diff old/graph.json new/graph.json

# Run all tests
pytest

# Run a single test file
pytest tests/test_invariants.py

# Run a single test by name
pytest tests/test_p3_resolve.py::TestResolver::test_reexport_chain

# Start the viewer dev server
cd viewer && npm run dev                    # → http://localhost:3000
cd viewer && npm run build                  # production build (always use --legacy-peer-deps for installs)
```

## Architecture

This is a two-part system: a Python CLI pipeline that produces `graph.json`, and a Next.js viewer that renders it.

### Python Pipeline (`pyviz/`)

Seven sequential passes, each reading the prior pass output without mutating it:

| Pass | File | Input → Output |
|------|------|----------------|
| P1 | `pipeline/p1_discovery.py` | repo path → `ModuleMap` (dotted names + file paths) |
| P2 | `pipeline/p2_parse.py` | `ModuleMap` → `dict[str, SymbolTable]` (AST-extracted definitions + bindings per module) |
| P3 | `pipeline/p3_resolve.py` | `SymbolTable` dict → `Resolver` (memoized, cycle-safe re-export resolver) |
| P4 | `pipeline/p4_edges.py` | `ModuleMap` + tables + resolver → `StaticGraph` (nodes + typed edges) |
| P5 | `pipeline/p5_trace.py` | repo path → `list[RuntimeEdge]` (optional; injects a conftest into the target's test suite) |
| P6 | `pipeline/p6_merge.py` | `StaticGraph` + runtime edges → merged graph with `provenance` field |
| P7 | `pipeline/p7_emit.py` | merged graph → `graph.json` + `run-manifest.json` |

All shared dataclasses live in `models.py`: `ModuleInfo`, `ModuleMap`, `SymbolTable`, `Definition`, `Binding`, `Resolution`, `GraphNode`, `GraphEdge`, `StaticGraph`, `RuntimeEdge`.

**Node kinds:** `module`, `package`, `class`, `function`, `method`, `coroutine`, `variable`, `external`

**Edge kinds:** `imports`, `calls`, `instantiates`, `inherits`, `decorates`, `defines`

**Edge fields:** `provenance` (`static` | `runtime` | `both`), `confidence` (`resolved` | `heuristic` | `dynamic-unresolved`)

Node and edge IDs are stable 16-char SHA-1 hex hashes computed from `(kind, relpath, qualname)` — so IDs are deterministic across runs.

### P3 Resolver — the critical pass

`Resolver.resolve(module, name)` follows re-export chains transitively. The key correctness invariant (§5.3): `from pkg import Foo` where `pkg/__init__.py` re-exports `Foo` from `pkg.core` must resolve to `pkg.core.Foo`, not `pkg.Foo`. The resolver is memoized per `(module, name)` pair and uses a `frozenset` seen-set for cycle detection.

The fixed bug to be aware of: `p2_parse.py::_resolve_relative` — for `__init__.py` files, `from .core import X` was previously computing the wrong package prefix. The fix detects the `__init__.py` suffix and preserves the full module path as the package.

### Viewer (`viewer/`)

Next.js 15 app. Single page (`app/page.tsx`) handles file upload (drag-drop or browse) and owns all filter state. Graph rendering is in `components/GraphView.tsx` using `@xyflow/react` v12 with dagre for automatic layout.

**Progressive disclosure model:** nodes start as collapsed module/package pills. Clicking a module/package expands it in-place to show its contained definitions. Expansion state is tracked in `GraphView` as a `Set<string>` of expanded node IDs.

**Filter dimensions** (all stored in `ViewFilters` in `lib/types.ts`):
- Node kinds — which symbol types are visible
- Edge kinds — which relationship types are drawn
- Provenance — static / runtime / both
- Confidence — resolved / heuristic (dynamic-unresolved hidden by default)

**Default view:** `defines` edges are OFF by default — turn them on to see module→symbol ownership edges. This is intentional: the default shows inter-module relationships without the visual noise of every define edge.

**Two gotchas:**
- `searchQuery` is NOT part of `ViewFilters` — it is managed as separate `useState<string>` in `page.tsx`. Do not add it to the `ViewFilters` interface or `DEFAULT_FILTERS`.
- `@import "@xyflow/react/dist/style.css"` must live in `app/globals.css` (as an `@import` at the top), not in any client component. Next.js App Router prohibits CSS imports from `node_modules` inside client components.

### Test fixtures (`fixtures/`)

Each subdirectory is a minimal Python package exercising one edge case:
- `reexport_chain/` — transitive re-export through `__init__.py`
- `wildcard/` — `from x import *` with `__all__`
- `cycle/` — circular re-export between modules
- `decorators/` — framework-style decorators
- `getattr_dispatch/` — `__getattr__`-based dynamic dispatch
- `dynamic_all/` — `__all__` computed at runtime (non-static)

### Windows CLI encoding

The CLI (`pyviz/cli.py`) must use only ASCII in terminal output — `->` not `→`, `...` not `…`. Windows cp1252 raises `UnicodeEncodeError` on non-ASCII characters written to stdout/stderr via Click's echo.

### Key invariants (enforced in `tests/test_invariants.py`)

1. No `imports`/`defines` edge may target a `__init__.py` file for a non-package node (§5.3)
2. No dangling edges — every edge source/target must exist in the node set
3. Determinism — two pipeline runs over the same input produce identical node/edge ID sets
