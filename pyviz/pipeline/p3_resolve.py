"""P3 — The re-export resolver (flagship correctness pass).

Given any (module, name), returns the true Definition site by following
re-export chains transitively through __init__.py and any other module.

Key properties (per TRD §5):
  - Transitive: re-export of re-export resolves to the real definition.
  - Memoized: each (module, name) resolved once — linear in distinct queries.
  - Cycle-safe: re-export cycles return status="cycle", surface a caveat.
  - Wildcard-aware: respects __all__ when statically known.
  - __all__-aware: a module's exported surface is __all__ if present.
"""
from __future__ import annotations

from typing import Optional

from pyviz.models import Resolution, SymbolTable


class Resolver:
    """Memoized, cycle-safe re-export resolver over a set of SymbolTables."""

    def __init__(self, tables: dict[str, SymbolTable]) -> None:
        self._tables = tables
        self._memo: dict[tuple[str, str], Resolution] = {}

    def resolve(
        self,
        module: str,
        name: str,
        seen: Optional[frozenset[tuple[str, str]]] = None,
    ) -> Resolution:
        """Resolve (module, name) → Resolution with true definition site."""
        key = (module, name)

        if key in self._memo:
            return self._memo[key]

        if seen is None:
            seen = frozenset()

        # Cycle guard
        if key in seen:
            r = Resolution(
                status="cycle",
                reason=f"re-export cycle detected at ({module}, {name})",
                chain=list(seen | {key}),
            )
            self._memo[key] = r
            return r

        seen = seen | {key}
        r = self._resolve_inner(module, name, seen)
        self._memo[key] = r
        return r

    def _resolve_inner(
        self, module: str, name: str, seen: frozenset[tuple[str, str]]
    ) -> Resolution:
        st = self._tables.get(module)
        if st is None:
            return Resolution(
                status="unresolved",
                reason=f"module '{module}' not in module map",
            )

        # 1. Defined right here?
        if name in st.definitions:
            return Resolution(
                status="resolved",
                def_module=module,
                def_qualname=name,
            )

        # 2. Explicitly bound (re-export via import)?
        if name in st.bindings:
            b = st.bindings[name]
            if b.is_wildcard:
                # Should not happen — wildcard bindings live in wildcard_sources, not bindings
                pass
            elif b.is_module_import:
                return Resolution(
                    status="resolved-module",
                    def_module=b.target_module,
                    def_qualname=None,
                )
            elif b.original_name is not None:
                # Follow the re-export chain
                return self.resolve(b.target_module, b.original_name, seen)
            else:
                # Bare "import x" binds module object; treat as module resolution
                return Resolution(
                    status="resolved-module",
                    def_module=b.target_module,
                    def_qualname=None,
                )

        # 3. Reachable via wildcard imports?
        if st.wildcard_sources:
            for src_module in st.wildcard_sources:
                src_st = self._tables.get(src_module)
                if src_st is None:
                    continue
                exported = self._exported_names(src_st)
                if name in exported:
                    return self.resolve(src_module, name, seen)
            return Resolution(
                status="unresolved",
                reason=f"'{name}' not found in any wildcard source of '{module}'",
            )

        # 4. Dead end.
        return Resolution(
            status="unresolved",
            reason=f"'{name}' not defined or imported in '{module}'",
        )

    def _exported_names(self, st: SymbolTable) -> frozenset[str]:
        """Names a module exports: __all__ if known, else public names."""
        if st.all_names is not None:
            return st.all_names
        if st.all_is_dynamic:
            # Cannot enumerate; return everything defined (conservative over-approximation)
            return frozenset(st.definitions) | frozenset(st.bindings)
        # No __all__: export all public names (not starting with _)
        public_defs = {k for k in st.definitions if not k.startswith("_")}
        public_bindings = {k for k in st.bindings if not k.startswith("_")}
        return public_defs | public_bindings

    def resolve_module_attr(self, module: str, attr: str) -> Resolution:
        """Resolve `module.attr` where `module` is already a dotted name."""
        return self.resolve(module, attr)


def build_resolver(tables: dict[str, SymbolTable]) -> Resolver:
    return Resolver(tables)
