"""P2 — Parse: build per-module SymbolTables from AST.

Output: dict[dotted_name, SymbolTable]

One ast.NodeVisitor walk per module extracts:
  - Definitions (functions, classes, methods, variables)
  - Bindings (imports, with relative imports resolved to absolute names)
  - __all__ contents (when statically determinable)
"""
from __future__ import annotations

import ast
import os
from pathlib import Path
from typing import Optional

from pyviz.models import Binding, Definition, ModuleMap, SymbolTable


def parse_all(module_map: ModuleMap) -> dict[str, SymbolTable]:
    """Parse every module in module_map and return {dotted_name: SymbolTable}."""
    tables: dict[str, SymbolTable] = {}
    for dotted, info in module_map.modules.items():
        try:
            st = _parse_module(dotted, info.path, module_map)
            tables[dotted] = st
        except (SyntaxError, OSError, UnicodeDecodeError):
            # Un-parseable modules get an empty symbol table; never crash the pipeline.
            tables[dotted] = SymbolTable(module_name=dotted, file_path=info.path)
    return tables


# ---------------------------------------------------------------------------
# Single-module parser
# ---------------------------------------------------------------------------


def _parse_module(dotted: str, path: str, module_map: ModuleMap) -> SymbolTable:
    source = Path(path).read_text(encoding="utf-8", errors="replace")
    tree = ast.parse(source, filename=path)

    st = SymbolTable(module_name=dotted, file_path=path)
    visitor = _ModuleVisitor(dotted, st, module_map)
    visitor.visit(tree)

    # Resolve __all__ after the full walk
    _resolve_all(st, visitor)

    return st


# ---------------------------------------------------------------------------
# AST visitor
# ---------------------------------------------------------------------------


class _ModuleVisitor(ast.NodeVisitor):
    """Single-pass AST walker that fills a SymbolTable."""

    def __init__(self, module_name: str, st: SymbolTable, module_map: ModuleMap) -> None:
        self.module_name = module_name
        self.st = st
        self.module_map = module_map
        self._scope_stack: list[str] = []  # stack of qualname prefixes
        self._raw_all: Optional[list[str]] = None  # raw __all__ from first assignment
        self._all_is_dynamic = False

    # ------------------------------------------------------------------
    # Imports
    # ------------------------------------------------------------------

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            local = alias.asname if alias.asname else alias.name
            # "import a.b.c" binds "a" (the top-level name) in the local ns
            top = alias.name.split(".")[0]
            local_key = alias.asname if alias.asname else top
            b = Binding(
                local_name=local_key,
                target_module=alias.name,
                original_name=None,
                is_module_import=True,
                lineno=node.lineno,
            )
            self.st.bindings[local_key] = b

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        # Resolve relative imports to absolute module names
        base = _resolve_relative(self.module_name, node.level, node.module, self.st.file_path)

        for alias in node.names:
            if alias.name == "*":
                self.st.wildcard_sources.append(base)
                continue
            local = alias.asname if alias.asname else alias.name
            b = Binding(
                local_name=local,
                target_module=base,
                original_name=alias.name,
                lineno=node.lineno,
            )
            self.st.bindings[local] = b

    # ------------------------------------------------------------------
    # Definitions
    # ------------------------------------------------------------------

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._handle_funcdef(node, is_async=False)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._handle_funcdef(node, is_async=True)

    def _handle_funcdef(
        self, node: ast.FunctionDef | ast.AsyncFunctionDef, is_async: bool
    ) -> None:
        qualname = self._make_qualname(node.name)
        kind, method_kind, is_abstract = _classify_function(node, self._scope_stack)

        decorator_names = [_expr_to_name(d) for d in node.decorator_list]

        defn = Definition(
            qualname=qualname,
            kind="coroutine" if is_async else kind,
            lineno=node.lineno,
            end_lineno=node.end_lineno or node.lineno,
            is_async=is_async,
            method_kind=method_kind,
            is_abstract=is_abstract,
            decorator_names=decorator_names,
        )
        self.st.definitions[qualname] = defn

        self._scope_stack.append(node.name)
        self.generic_visit(node)
        self._scope_stack.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        qualname = self._make_qualname(node.name)
        bases = [_expr_to_name(b) for b in node.bases]
        decorator_names = [_expr_to_name(d) for d in node.decorator_list]

        # Detect abstractness: inherits from abc.ABC or uses ABCMeta
        is_abstract = any(
            b in ("ABC", "abc.ABC", "ABCMeta", "abc.ABCMeta") for b in bases
        )
        keywords = {kw.arg: _expr_to_name(kw.value) for kw in node.keywords}
        if keywords.get("metaclass") in ("ABCMeta", "abc.ABCMeta"):
            is_abstract = True

        defn = Definition(
            qualname=qualname,
            kind="class",
            lineno=node.lineno,
            end_lineno=node.end_lineno or node.lineno,
            bases_exprs=bases,
            decorator_names=decorator_names,
            is_abstract=is_abstract,
        )
        self.st.definitions[qualname] = defn

        self._scope_stack.append(node.name)
        self.generic_visit(node)
        self._scope_stack.pop()

    def visit_Assign(self, node: ast.Assign) -> None:
        if self._scope_stack:
            return  # Only capture module-level and class-level variables
        for target in node.targets:
            if isinstance(target, ast.Name):
                if target.id == "__all__":
                    self._capture_all(node.value)
                    return
                qualname = self._make_qualname(target.id)
                self.st.definitions[qualname] = Definition(
                    qualname=qualname,
                    kind="variable",
                    lineno=node.lineno,
                    end_lineno=node.end_lineno or node.lineno,
                )

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if self._scope_stack:
            return
        if isinstance(node.target, ast.Name):
            qualname = self._make_qualname(node.target.id)
            self.st.definitions[qualname] = Definition(
                qualname=qualname,
                kind="variable",
                lineno=node.lineno,
                end_lineno=node.end_lineno or node.lineno,
            )

    # ------------------------------------------------------------------
    # __all__ capture
    # ------------------------------------------------------------------

    def _capture_all(self, value: ast.expr) -> None:
        """Record __all__ if it's a static list/tuple of string literals."""
        if isinstance(value, (ast.List, ast.Tuple)):
            names: list[str] = []
            for elt in value.elts:
                if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                    names.append(elt.value)
                else:
                    self._all_is_dynamic = True
                    return
            self._raw_all = names
        else:
            self._all_is_dynamic = True

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _make_qualname(self, name: str) -> str:
        if self._scope_stack:
            return ".".join(self._scope_stack) + "." + name
        return name


def _resolve_all(st: SymbolTable, visitor: _ModuleVisitor) -> None:
    if visitor._all_is_dynamic:
        st.all_is_dynamic = True
        st.all_names = None
    elif visitor._raw_all is not None:
        st.all_names = frozenset(visitor._raw_all)
    # else: no __all__ at all — caller treats as "public names not starting with _"


# ---------------------------------------------------------------------------
# Relative import resolution
# ---------------------------------------------------------------------------


def _resolve_relative(
    module_name: str, level: int, module: Optional[str], file_path: str = ""
) -> str:
    """Convert a relative import to an absolute dotted module name.

    Follows CPython's importlib._bootstrap._resolve_name logic:
      package = the dotted name of the package containing this module.
      For __init__.py files, the module IS the package (don't strip the last component).
      For regular modules, strip the rightmost component to get the package.
      Then strip (level-1) more components for level > 1.
    """
    if level == 0:
        return module or ""

    # Determine the "containing package" for this file
    normalized_path = file_path.replace("\\", "/")
    if normalized_path.endswith("/__init__.py") or normalized_path == "__init__.py":
        # This file IS the package — don't strip the last dotted component
        package = module_name
    elif "." in module_name:
        # Regular module inside a package — strip the rightmost component
        package = module_name.rsplit(".", 1)[0]
    else:
        # Top-level module with no package — level-1 relative import goes to ""
        package = ""

    # Strip (level-1) additional package components for level > 1
    if level > 1:
        parts = package.rsplit(".", level - 1)
        package = parts[0] if parts else ""

    if not package:
        return module or ""
    return f"{package}.{module}" if module else package


# ---------------------------------------------------------------------------
# Function/method classification
# ---------------------------------------------------------------------------


def _classify_function(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    scope_stack: list[str],
) -> tuple[str, Optional[str], bool]:
    """Return (kind, method_kind, is_abstract)."""
    in_class = bool(scope_stack)  # top of stack would be a class name
    decorator_names = [_expr_to_name(d) for d in node.decorator_list]

    is_abstract = "abstractmethod" in decorator_names or "abc.abstractmethod" in decorator_names

    if not in_class:
        return "function", None, is_abstract

    if "classmethod" in decorator_names:
        return "method", "classmethod", is_abstract
    if "staticmethod" in decorator_names:
        return "method", "staticmethod", is_abstract
    if "property" in decorator_names or "property.getter" in decorator_names:
        return "method", "instance", is_abstract

    return "method", "instance", is_abstract


# ---------------------------------------------------------------------------
# AST expression → string name (best-effort, for display/tracking)
# ---------------------------------------------------------------------------


def _expr_to_name(node: ast.expr) -> str:
    """Convert a decorator / base expression to a dotted string name."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _expr_to_name(node.value)
        return f"{parent}.{node.attr}"
    if isinstance(node, ast.Call):
        return _expr_to_name(node.func)
    if isinstance(node, ast.Subscript):
        return _expr_to_name(node.value)
    return "<complex>"
