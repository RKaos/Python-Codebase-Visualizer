# QA Test Plan — pyviz

This document describes **what** is tested in pyviz, **why**, **how to run** the tests, and the
**current coverage** with its known gaps. It is the quality-assurance reference for the project.

---

## 1. Scope & objective

pyviz is a two-part system:

- a **Python pipeline** (`pyviz/`) that analyses a codebase and emits `graph.json`, and
- a **Next.js viewer** (`viewer/`) that renders it.

QA effort is concentrated on the **Python pipeline**, because that is where *correctness* lives — a
wrong edge or a mis-resolved import silently produces a misleading graph. The viewer is a
presentation layer; a rendering glitch is visible and low-risk, whereas a bad edge is invisible and
high-risk. The test suite therefore protects the analysis logic, and especially the **P3 re-export
resolver** (the most subtle pass).

---

## 2. Test strategy (the test pyramid, mapped to pyviz)

| Layer | What it verifies | Where |
|-------|------------------|-------|
| **Unit** | a single function/pass in isolation, over hand-built inputs | `tests/test_p3_resolve.py` |
| **Integration** | passes P1→P7 working together over real fixture packages | `tests/test_invariants.py` |
| **Invariant / property** | a rule that must hold for *every* graph | `TestGraphInvariants` |
| **Regression** | a previously-fixed bug stays fixed (golden assertion) | `test_thing_resolves_to_core_not_init` |

We favour many fast unit tests at the base and a smaller number of integration tests on top. The
whole suite runs in **< 1 second**, so it is cheap to run on every change.

---

## 3. Test inventory (36 tests)

### Unit tests — `tests/test_p3_resolve.py`
Exercise the resolver over hand-built `SymbolTable`s (no filesystem), so failures point precisely at
resolver logic.

- **Re-export chain** — `from pkg import Thing` resolves to `pkg.core.Thing`, not `pkg.__init__`
  (the §5.3 golden invariant); helper re-export; direct lookup; unknown-name → `unresolved`;
  **memoization** (same `(module, name)` returns the cached object).
- **Wildcard** — `from x import *` honours `__all__`; names not exported stay `unresolved`.
- **Cycle** — circular re-export terminates and returns `status="cycle"` (no infinite recursion);
  a cycle that bottoms out at a real definition resolves.
- **Module import** — `import pkg.core as core` resolves to `resolved-module`.

### Integration & invariant tests — `tests/test_invariants.py`
Run the **full pipeline** over the `fixtures/` packages and assert global properties.

- **§5.3 init-targeting invariant** — no `imports` edge targets `__init__.py` for a non-package
  definition (checked on `reexport_chain`, `wildcard`, `decorators`).
- **No dangling edges** — every edge `source`/`target` exists in the node set
  (parametrized over all 6 fixtures).
- **Determinism** — two runs over the same fixture produce identical node/edge ID sets
  (parametrized over all 6 fixtures). This protects the stable-hash ID contract.
- **Fixture-specific assertions** — `Thing` node exists in `pkg/core.py`; `Widget` resolves through
  the wildcard; `dynamic_all` is flagged `all_is_dynamic`.

### Test fixtures — `fixtures/`
Each is a minimal package isolating one hard case: `reexport_chain`, `wildcard`, `cycle`,
`decorators`, `getattr_dispatch`, `dynamic_all`.

---

## 4. How to run

```bash
pip install -e ".[dev]"                 # installs pytest + pytest-cov

pytest                                  # run the whole suite
pytest tests/test_invariants.py         # one file
pytest tests/test_p3_resolve.py::TestReexportChain::test_thing_resolves_to_core_not_init   # one test

# Coverage
pytest --cov=pyviz --cov-report=term-missing      # coverage in the terminal
pytest --cov=pyviz --cov-report=html              # browsable report at htmlcov/index.html
```

---

## 5. Coverage report

Latest run — **36 passed, 58% line coverage** (`pytest --cov=pyviz`):

| Module | Coverage | Note |
|--------|---------:|------|
| `models.py` | **100%** | all dataclasses exercised |
| `pipeline/p3_resolve.py` | **83%** | the critical resolver — well covered |
| `pipeline/p2_parse.py` | **82%** | AST extraction |
| `pipeline/p4_edges.py` | 72% | edge construction |
| `pipeline/p1_discovery.py` | 59% | module discovery |
| `pipeline/p7_emit.py` | 33% | JSON emission (I/O) |
| `pipeline/p6_merge.py` | 27% | runtime-merge paths uncovered |
| `pipeline/p5_trace.py` | 0% | runtime tracing — needs `--trace` |
| `cli.py` | 0% | CLI entry not invoked by tests |
| **TOTAL** | **58%** | |

**Interpretation.** Coverage is intentionally weighted toward correctness: the resolver, parser, and
data model — where a bug corrupts the graph — sit at 82–100%. The low-coverage modules are almost
all **I/O and orchestration** (`cli`, `p7_emit`, `p5_trace`, runtime branches of `p6_merge`), where
behaviour is observable and lower-risk. A high *total* number would be vanity; the distribution is
what matters.

---

## 6. Known gaps & risk assessment

| Gap | Risk | Planned mitigation |
|-----|------|--------------------|
| **Viewer (`viewer/`) has no automated tests** | Medium — layout/edge-bundling logic is non-trivial | Add Vitest unit tests for `lib/layout.ts` and the bundling helpers (pure functions, no DOM); later a Playwright smoke test (load app → upload `graph.json` → assert nodes render) |
| **CLI (`cli.py`) at 0%** | Low — thin Click wrapper over tested passes | Add a smoke test invoking `pyviz analyze <fixture>` via `CliRunner` and asserting a valid `graph.json` |
| **Runtime tracing (`p5_trace.py`) untested** | Medium — only runs under `--trace` | Add an integration test that traces a fixture with a tiny test suite and asserts `provenance="runtime"`/`"both"` edges appear |
| **`p6_merge` runtime branch at 27%** | Medium | Covered together with the trace test above |
| **No coverage threshold enforced** | Low | Optionally add `--cov-fail-under=55` so coverage can't silently regress |

---

## 7. Continuous integration (recommended next step)

The suite is fast and deterministic, so it is a good CI candidate. A minimal GitHub Actions job would
`pip install -e ".[dev]"` then run `pytest --cov=pyviz --cov-fail-under=55` on every push/PR — turning
these tests into an automated quality gate rather than a manual step.
