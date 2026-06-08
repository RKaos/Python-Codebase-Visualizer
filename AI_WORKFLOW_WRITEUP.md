# AI Workflow Writeup
## pyviz — Python Codebase Visualizer

**Author:** Afnan  
**Assessment:** Manaracloud.ai | Enablers.ai  

---

## 1. How I scoped and decomposed the work

Before writing a single line of code, I produced a full Technical Requirements Document
(`TRD_Python_Codebase_Visualizer.md`). The TRD locked in:

- The architectural decision (hybrid CLI + web viewer, with the analysis core in Python)
- A numbered pass model (P1 Discovery → P7 Emit) so each pass had a clear input/output contract
- The data schema for `graph.json` — before any implementation, so both the CLI and viewer could be built against a stable contract
- The headline invariant (`n_init_targeted_definition_edges == 0`) as an automated test
- Explicit lists of what was in scope and what was deliberately deferred

This front-loading was the most important decision I made. The TRD became the specification
I handed to the agent for each piece of work. Without it, agent output on something as
semantically tricky as Python import resolution tends to collapse into "I ran ast and drew
lines."

**Decomposition strategy:** I split the work into three independent tracks that could
proceed in parallel once the TRD's data model was agreed:

1. **Python core (P1–P7)** — correctness-critical; deterministic; must work without the viewer
2. **Next.js viewer** — pure consumer of `graph.json`; no knowledge of the analysis logic
3. **Fixtures + tests** — hand-built packages with known ground truth, written concurrently
   with the passes they exercise

The data model (`pyviz/models.py`) was the only shared dependency across all three tracks.
I wrote it first, reviewed it carefully, and treated it as a contract — not something the
agent was free to refactor mid-stream.

---

## 2. Prompts given to agents (verbatim)

### Prompt 1 — Analysis pipeline implementation

> The Technical Requirements Document is attached. Proceed with the implementation
> according to the architectural guidelines and constraints we established.
>
> Implement the full Python analysis pipeline (P1–P7) in `pyviz/pipeline/`, the CLI in
> `pyviz/cli.py`, the shared data models in `pyviz/models.py`, the six fixture packages in
> `fixtures/`, and the test suite in `tests/`. Then implement the Next.js viewer in
> `viewer/` with React Flow, dagre layout, filter bar, and node side panel. Follow the
> schema in §8 of the TRD exactly. Priority order: correctness of P3 (re-export resolver)
> over surface area everywhere else.

**What the agent produced:** Complete implementation across all files — P1 through P7,
CLI, fixtures, test suite, Next.js viewer, package configs. The agent correctly
structured the pipeline as immutable passes, implemented the memoized cycle-safe resolver,
and generated a test suite with the §5.3 invariant check. The overall architecture was
sound.

---

### Prompt 2 — Relative import resolution spec (pre-implementation clarification)

This was a specification decision I made before handing off the implementation, not a
prompt I used to debug a failure. I included the following constraint explicitly in the TRD:

> **Relative imports** (`from . import x`, `from ..pkg import y`) are resolved against the
> current package using the level count and the module's own dotted name — done in P2, so
> P3 only ever deals in absolute dotted names.

The reason I spelled this out: relative import resolution is the #1 place where AST-only
tools get `__init__.py` resolution wrong. Specifically, `from .core import X` in
`pkg/__init__.py` must resolve to `pkg.core`, not `core`. If the agent wasn't told how
CPython resolves relative imports (strip the rightmost component for regular modules; keep
the full name for `__init__.py` files because the module name *is* the package), it would
implement the wrong algorithm and the §5.3 invariant would fail silently until you looked
at an actual graph edge.

---

### Prompt 3 — Viewer layout spec

> The viewer must use module-first progressive disclosure: the default view renders only
> module/package nodes. Clicking a module expands its definitions (class/function/method
> children). Never render more than ~1–2k React Flow nodes simultaneously. Server-side
> layout with dagre — no live force simulation. Filter bar must treat `imports` and `calls`
> as independently toggleable edge kinds (this is a first-class UI requirement, not a nice-
> to-have). Provenance styling: both=solid animated, static=solid, runtime=dashed. Low-
> confidence edges visually muted. Node click opens a side panel with: file path, line range,
> inbound/outbound neighbors with kind+provenance badges, caveats.

**What the agent produced:** `GraphView.tsx` with module-first expansion logic, dagre
layout in `lib/layout.ts`, `FilterBar.tsx` with separate toggles for each edge kind, and
`NodePanel.tsx` with the neighbor list. The structure matched the spec closely. The one gap
was that `searchQuery` was initially included in the `ViewFilters` TypeScript interface even
though I manage it as separate React state — caught by the TypeScript compiler during `npm
run build`.

---

## 3. Cases where I rejected or corrected AI output

### Case 1 — The relative import resolver bug (critical)

**What was wrong:** The initial implementation of `_resolve_relative` in `p2_parse.py`
produced the wrong module name for relative imports in `__init__.py` files. Specifically,
`from .core import Thing` in `pkg/__init__.py` resolved to `"core"` instead of `"pkg.core"`.

The algorithm the agent implemented was:
```python
parts = module_name.split(".")          # ["pkg"] for __init__.py
base_parts = parts[:-level]             # [] — stripped "pkg" away entirely
return ".".join(base_parts + [module])  # → "core" ❌
```

This is wrong because it treated `pkg/__init__.py` the same as a regular module inside a
package (like `pkg/core.py`). For a regular module `pkg.core`, stripping the last component
gives `pkg` — correct. For `pkg/__init__.py`, the module name *is* the package name (`pkg`),
so stripping it gives nothing — the prefix disappears and the import resolves to a bare name.

**How I caught it:** The §5.3 invariant test failed:
```
FAILED tests/test_invariants.py::TestReexportChainFixture::test_thing_import_targets_core_not_init
AssertionError: Expected pkg.core, got 'unresolved'
```

I then debugged interactively:
```python
from pyviz.pipeline.p2_parse import _resolve_relative
_resolve_relative("pkg", 1, "core")  # → "core" ← wrong
```

**How I fixed it:** I added a `file_path` parameter to `_resolve_relative` and implemented
CPython's actual algorithm from `importlib._bootstrap._resolve_name`:

```python
# Detect whether this file IS the package (i.e., __init__.py)
if file_path.replace("\\", "/").endswith("/__init__.py"):
    package = module_name          # don't strip: "pkg" → "pkg"
elif "." in module_name:
    package = module_name.rsplit(".", 1)[0]   # "pkg.core" → "pkg"
else:
    package = ""

# Then apply level-1 additional strips for deeper relative imports
if level > 1:
    parts = package.rsplit(".", level - 1)
    package = parts[0] if parts else ""

return f"{package}.{module}" if module else package
```

After the fix: `_resolve_relative("pkg", 1, "core", "pkg/__init__.py")` → `"pkg.core"` ✓

This is exactly the kind of bug the assessment warns about: *"agents will confidently emit
parser code that mishandles `__init__.py` re-exports"*. The automated invariant caught it
before it could silently corrupt any graph output.

---

### Case 2 — TypeScript `ViewFilters` interface with extra field

**What was wrong:** The `ViewFilters` TypeScript interface included a `searchQuery: string`
field, but `page.tsx` already managed search as separate React state
(`useState<string>("")`). This meant `DEFAULT_FILTERS` was missing a required field.
TypeScript caught it:

```
Type error: Property 'searchQuery' is missing in type '{ nodeKinds: Set<...>; ... }'
but required in type 'ViewFilters'.
```

**How I caught it:** `npm run build` failed. The compilation step is non-negotiable
exactly for this reason — silent runtime type errors are worse than build failures.

**How I fixed it:** Removed `searchQuery` from `ViewFilters`. Search is orthogonal to
graph filtering (it acts on the already-filtered visible set, not on the filter state
itself), so it shouldn't be bundled into the filter object. The component signatures
and `FilterBar` props didn't need `searchQuery` at all.

---

### Case 3 — CSS import location in Next.js App Router

**What was wrong:** The agent placed `import "@xyflow/react/dist/style.css"` directly in
`components/GraphView.tsx`. In Next.js App Router, CSS imports from `node_modules` cannot
appear in client components — they must be in `app/layout.tsx` or `app/globals.css`.
The build failed:

```
Error: Cannot find module 'autoprefixer'
...
./node_modules/@xyflow/react/dist/style.css
./components/GraphView.tsx
./app/page.tsx
> Build failed because of webpack errors
```

(The `autoprefixer` error was a secondary consequence of the wrong CSS processing path.)

**How I caught it:** The build failed with a webpack error pointing directly at the import
chain: `GraphView.tsx → @xyflow/react/dist/style.css`.

**How I fixed it:** Moved the CSS import to `app/globals.css` as an `@import` at the top:
```css
@import "@xyflow/react/dist/style.css";
```
and added `autoprefixer` to `package.json` devDependencies (it was referenced in
`postcss.config.js` but not listed). This is a well-known Next.js App Router constraint
that the agent didn't account for.

---

## 4. How I verified the graph is correct

### Automated invariant (§5.3 — the headline test)

The most important invariant runs on every `pyviz verify` call and in CI:

```
stats.n_init_targeted_definition_edges == 0
```

This directly encodes the requirement: no `imports` or `defines` edge may target
`__init__.py` for a symbol whose true definition is elsewhere. If this number is non-zero,
the resolver has a bug.

### Hand-built fixture packages

Six fixture packages, each exercising exactly one hard case:

| Fixture | Exercises | Key assertion |
|---|---|---|
| `reexport_chain` | `__init__` → `core` → `impl` chain | `from pkg import Thing` resolves to `pkg/core.py`, not `__init__.py` |
| `wildcard` | `from .core import *` + `__all__` | `Widget` resolves to `core.py`; `_internal` (not in `__all__`) does not |
| `cycle` | re-export cycle | resolver terminates; returns `status: cycle`; no infinite recursion |
| `decorators` | plain / factory / framework decorators | `list_items` tagged `framework_entrypoint`; `decorates` edge from `my_decorator` to `get_items` |
| `getattr_dispatch` | `getattr(obj, name)()` | no false call edge; callee is genuinely `dynamic-unresolved` |
| `dynamic_all` | `__all__ = base + [...]` | `all_is_dynamic: true`; caveat surfaced; no guessed wildcard expansion |

Every fixture test asserts both the positive case (correct resolution) and the negative
case (things that should *not* resolve don't).

### Determinism test

```python
g1, *_ = run_pipeline(fixture)
g2, *_ = run_pipeline(fixture)
assert set(g1.nodes) == set(g2.nodes)
assert {e.id for e in g1.edges} == {e.id for e in g2.edges}
```

Two runs over the same input must produce identical node/edge id sets. This catches
non-determinism in dict iteration, set ordering, or memoization state leaks.

### Spot-check on the reexport_chain output

```
imports static pkg      -> pkg/core.py :: Thing
imports static pkg      -> pkg/core.py :: helper
imports static user     -> pkg/core.py :: Thing   ← not __init__.py
```

The `user.py` module imports `Thing` from the package top-level; the edge correctly
resolves to `pkg/core.py::Thing` (not `pkg/__init__.py`).

### Differential comparison against pydeps / pyan

For any disagreement between pyviz and an AST-only tool on a `from pkg import X` edge,
I check which file actually defines `X`. pyviz consistently wins on `__init__.py`
re-export cases — which is the core differentiator.

---

## 5. Decisions not shipped, and why

**Speculative type inference for attribute calls.** The honest position — stated in the
README and surfaced as `dynamic-unresolved` edges — is more trustworthy than a
type-inference approximation that would produce wrong edges. A wrong edge is worse than
a missing one.

**Full `<locals>` qualname markers.** CPython uses `func.<locals>.nested` for nested
functions. The implementation uses `func.nested`. This affects the runtime join for
deeply-nested functions. Since the primary graph nodes of interest (module → class →
method) are unaffected, and correcting it adds complexity with diminishing return for
the interview scope, it's documented as a known limitation rather than fixed.

**Supabase persistence.** Local-first is the right default for a code analysis tool.
Auth makes sense only in a shared-team hosted scenario. Shipping auth for solo local
use would add 300+ lines of code for zero reviewer benefit. The schema is documented
in `.env.example` and the README; the decision is explicit and defensible.

**`pyviz diff` viewer.** The CLI `diff` command computes the structural difference between
two graph artifacts correctly. The viewer does not yet render a diff view. Implementing
the viewer diff (add/remove node/edge styling) was cut to keep the viewer codebase
reviewable in a 30-minute interview session.

**Dead-code detection via coverage cross-validation.** The pipeline collects coverage
data as a side effect of runtime tracing. Surfacing `static-only` edges that correspond
to never-executed code as "dead-code candidates" is architecturally correct (the merge
buckets already produce exactly this signal) but requires a UI surface (a dedicated panel
or badge) that was deferred to keep the viewer scope tight.
