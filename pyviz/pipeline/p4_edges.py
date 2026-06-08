"""P4 — Static edge extraction.

Second AST walk per module, now with the resolved binding table available.
Emits: imports, defines, inherits, decorates, calls edges.

Soundness discipline (per TRD §6.4):
  When the callee cannot be proven, we emit nothing (or a dynamic-unresolved
  placeholder) rather than guessing. Consistently correct edges over 60% of
  semantics beats incorrect edges over 100%.
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import Optional

from pyviz.models import (
    GraphEdge,
    GraphNode,
    ModuleMap,
    Resolution,
    StaticGraph,
    SymbolTable,
    make_edge_id,
    make_node_id,
)
from pyviz.pipeline.p3_resolve import Resolver

# Known framework decorators that register functions as entrypoints (called by the framework).
_FRAMEWORK_DECORATOR_ROOTS = frozenset(
    {
        "app.route",
        "app.get",
        "app.post",
        "app.put",
        "app.patch",
        "app.delete",
        "app.head",
        "app.options",
        "app.websocket",
        "router.get",
        "router.post",
        "router.put",
        "router.patch",
        "router.delete",
        "router.route",
        "bp.route",
        "bp.get",
        "bp.post",
        "celery.task",
        "shared_task",
        "click.command",
        "click.group",
        "pytest.fixture",
        "pytest.mark",
        "property",
    }
)


def extract_static_graph(
    module_map: ModuleMap,
    tables: dict[str, SymbolTable],
    resolver: Resolver,
    repo_root: str,
) -> StaticGraph:
    graph = StaticGraph()

    # First pass: create all module/package nodes and definition nodes
    for dotted, st in tables.items():
        _add_module_node(dotted, st, module_map, repo_root, graph)
        _add_definition_nodes(dotted, st, repo_root, graph)

    # Second pass: emit all edge types per module
    for dotted, st in tables.items():
        extractor = _ModuleEdgeExtractor(dotted, st, tables, resolver, module_map, repo_root, graph)
        extractor.run()

    return graph


# ---------------------------------------------------------------------------
# Node creation helpers
# ---------------------------------------------------------------------------


def _relpath_posix(abs_path: str, repo_root: str) -> str:
    try:
        rel = Path(abs_path).relative_to(repo_root)
    except ValueError:
        rel = Path(abs_path).name
    return rel.as_posix()


def _add_module_node(
    dotted: str, st: SymbolTable, module_map: ModuleMap, repo_root: str, graph: StaticGraph
) -> None:
    info = module_map.modules.get(dotted)
    if info is None:
        return
    kind = "package" if info.is_package else "module"
    relpath = _relpath_posix(st.file_path, repo_root)
    nid = make_node_id(kind, relpath, "")
    node = GraphNode(
        id=nid,
        kind=kind,
        name=dotted.split(".")[-1],
        qualname=dotted,
        module=dotted,
        file_path=relpath,
        line_start=1,
        line_end=1,
        attributes={
            "is_namespace_package": info.is_namespace,
            "all_is_dynamic": st.all_is_dynamic,
            "dotted_name": dotted,
        },
        caveats=(_dynamic_all_caveat(st)),
    )
    graph.nodes[nid] = node


def _dynamic_all_caveat(st: SymbolTable) -> list[str]:
    if st.all_is_dynamic:
        return ["__all__ is dynamically constructed; wildcard resolution is approximate"]
    return []


def _add_definition_nodes(
    dotted: str, st: SymbolTable, repo_root: str, graph: StaticGraph
) -> None:
    relpath = _relpath_posix(st.file_path, repo_root)
    for qualname, defn in st.definitions.items():
        kind = defn.kind
        nid = make_node_id(kind, relpath, qualname)
        attrs: dict = {
            "is_async": defn.is_async,
            "method_kind": defn.method_kind,
            "is_abstract": defn.is_abstract,
            "decorators": defn.decorator_names,
            "framework_entrypoint": False,
        }
        node = GraphNode(
            id=nid,
            kind=kind,
            name=qualname.split(".")[-1],
            qualname=qualname,
            module=dotted,
            file_path=relpath,
            line_start=defn.lineno,
            line_end=defn.end_lineno,
            attributes=attrs,
            caveats=[],
        )
        graph.nodes[nid] = node


# ---------------------------------------------------------------------------
# Per-module edge extractor
# ---------------------------------------------------------------------------


class _ModuleEdgeExtractor:
    def __init__(
        self,
        module_name: str,
        st: SymbolTable,
        tables: dict[str, SymbolTable],
        resolver: Resolver,
        module_map: ModuleMap,
        repo_root: str,
        graph: StaticGraph,
    ) -> None:
        self.module_name = module_name
        self.st = st
        self.tables = tables
        self.resolver = resolver
        self.module_map = module_map
        self.repo_root = repo_root
        self.graph = graph
        self._relpath = _relpath_posix(st.file_path, repo_root)

    def run(self) -> None:
        self._emit_defines_edges()
        self._emit_imports_edges()
        try:
            source = Path(self.st.file_path).read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(source)
        except (SyntaxError, OSError):
            return
        self._emit_inherits_and_decorates(tree)
        self._emit_calls(tree)

    # ------------------------------------------------------------------
    # defines edges: module → definitions, class → methods
    # ------------------------------------------------------------------

    def _emit_defines_edges(self) -> None:
        mod_node_id = self._module_node_id()
        if mod_node_id not in self.graph.nodes:
            return
        for qualname, defn in self.st.definitions.items():
            target_id = make_node_id(defn.kind, self._relpath, qualname)
            if target_id not in self.graph.nodes:
                continue
            # Module → top-level definition
            parts = qualname.split(".")
            if len(parts) == 1:
                self._add_edge(mod_node_id, target_id, "defines", "resolved")
            elif len(parts) == 2:
                # Class.method — emit class → method
                parent_qualname = parts[0]
                parent_def = self.st.definitions.get(parent_qualname)
                if parent_def:
                    parent_id = make_node_id(parent_def.kind, self._relpath, parent_qualname)
                    if parent_id in self.graph.nodes:
                        self._add_edge(parent_id, target_id, "defines", "resolved")
                    else:
                        self._add_edge(mod_node_id, target_id, "defines", "resolved")
                else:
                    self._add_edge(mod_node_id, target_id, "defines", "resolved")

    # ------------------------------------------------------------------
    # imports edges: this module → resolved definition sites
    # ------------------------------------------------------------------

    def _emit_imports_edges(self) -> None:
        src_id = self._module_node_id()
        if src_id not in self.graph.nodes:
            return

        for local_name, binding in self.st.bindings.items():
            if binding.is_wildcard:
                continue
            if binding.is_module_import:
                # Bind to the target module node
                tgt_mod_info = self.module_map.modules.get(binding.target_module)
                if tgt_mod_info is None:
                    continue
                tgt_relpath = _relpath_posix(tgt_mod_info.path, self.repo_root)
                tgt_kind = "package" if tgt_mod_info.is_package else "module"
                tgt_id = make_node_id(tgt_kind, tgt_relpath, "")
                if tgt_id in self.graph.nodes:
                    self._add_edge(
                        src_id, tgt_id, "imports", "resolved",
                        meta={"local_name": local_name, "kind": "module-import"},
                    )
            else:
                # from x import y — resolve to true definition site
                res = self.resolver.resolve(binding.target_module, binding.original_name or local_name)
                tgt_id = self._resolution_to_node_id(res)
                if tgt_id:
                    caveats = []
                    if res.status == "cycle":
                        caveats = [f"re-export cycle: {res.reason}"]
                    self._add_edge(
                        src_id, tgt_id, "imports", _res_confidence(res),
                        meta={"local_name": local_name, "original_name": binding.original_name},
                        caveats=caveats,
                    )

    # ------------------------------------------------------------------
    # inherits + decorates edges
    # ------------------------------------------------------------------

    def _emit_inherits_and_decorates(self, tree: ast.Module) -> None:
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                self._process_class_bases(node)
                self._process_class_decorators(node)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._process_func_decorators(node)

    def _process_class_bases(self, node: ast.ClassDef) -> None:
        class_qualname = _node_qualname(node)
        class_def = self.st.definitions.get(class_qualname)
        if class_def is None:
            return
        class_id = make_node_id("class", self._relpath, class_qualname)
        if class_id not in self.graph.nodes:
            return

        for base in node.bases:
            base_name = _expr_to_name(base)
            res = self._resolve_name_in_scope(base_name)
            tgt_id = self._resolution_to_node_id(res)
            if tgt_id and tgt_id in self.graph.nodes:
                self._add_edge(class_id, tgt_id, "inherits", _res_confidence(res))

    def _process_class_decorators(self, node: ast.ClassDef) -> None:
        class_qualname = _node_qualname(node)
        class_def = self.st.definitions.get(class_qualname)
        if class_def is None:
            return
        class_id = make_node_id("class", self._relpath, class_qualname)
        self._emit_decorator_edges(node.decorator_list, class_id)

    def _process_func_decorators(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        func_qualname = _node_qualname(node)
        func_def = self.st.definitions.get(func_qualname)
        if func_def is None:
            return
        func_kind = func_def.kind
        func_id = make_node_id(func_kind, self._relpath, func_qualname)
        is_framework_ep = self._emit_decorator_edges(node.decorator_list, func_id)
        if is_framework_ep:
            node_obj = self.graph.nodes.get(func_id)
            if node_obj:
                node_obj.attributes["framework_entrypoint"] = True

    def _emit_decorator_edges(
        self, decorators: list[ast.expr], target_id: str
    ) -> bool:
        """Emit decorates edges; return True if any is a framework entrypoint."""
        is_framework = False
        for dec in decorators:
            dec_name = _expr_to_name(dec)
            is_factory = isinstance(dec, ast.Call)
            is_fw = any(dec_name.startswith(fw) for fw in _FRAMEWORK_DECORATOR_ROOTS)
            if is_fw:
                is_framework = True

            res = self._resolve_name_in_scope(dec_name)
            src_id = self._resolution_to_node_id(res)
            if src_id and src_id in self.graph.nodes:
                caveats = []
                if is_factory:
                    caveats.append("decorator factory — result of a call, not the function itself")
                self._add_edge(
                    src_id, target_id, "decorates", _res_confidence(res),
                    meta={"is_factory": is_factory, "is_framework": is_fw},
                    caveats=caveats,
                )
        return is_framework

    # ------------------------------------------------------------------
    # calls edges (static call graph)
    # ------------------------------------------------------------------

    def _emit_calls(self, tree: ast.Module) -> None:
        """Walk every Call node in function bodies and emit calls edges."""
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                caller_qualname = _node_qualname(node)
                caller_def = self.st.definitions.get(caller_qualname)
                if caller_def is None:
                    continue
                caller_id = make_node_id(caller_def.kind, self._relpath, caller_qualname)
                if caller_id not in self.graph.nodes:
                    continue

                for child in ast.walk(node):
                    if isinstance(child, ast.Call):
                        self._process_call(child, caller_id, caller_qualname, node)

    def _process_call(
        self,
        call_node: ast.Call,
        caller_id: str,
        caller_qualname: str,
        func_node: ast.FunctionDef | ast.AsyncFunctionDef,
    ) -> None:
        func_expr = call_node.func
        callee_name = _expr_to_name(func_expr)

        # Bare name: foo()
        if isinstance(func_expr, ast.Name):
            res = self._resolve_name_in_scope(func_expr.id)
            self._emit_call_edge(caller_id, res, callee_name, call_node.lineno)

        # self.method() or cls.method()
        elif (
            isinstance(func_expr, ast.Attribute)
            and isinstance(func_expr.value, ast.Name)
            and func_expr.value.id in ("self", "cls")
        ):
            # Find enclosing class for MRO resolution
            class_name = caller_qualname.split(".")[0]
            class_def = self.st.definitions.get(class_name)
            if class_def and class_def.bases_exprs:
                # Try to resolve via class itself first
                method_name = func_expr.attr
                # Check if method is defined in this class
                full_method = f"{class_name}.{method_name}"
                if full_method in self.st.definitions:
                    target_def = self.st.definitions[full_method]
                    target_id = make_node_id(target_def.kind, self._relpath, full_method)
                    if target_id in self.graph.nodes:
                        self._emit_edge_resolved(caller_id, target_id, "calls", "resolved", call_node.lineno)
                        return
            # Could not resolve self.method statically → heuristic
            self._emit_dynamic_placeholder(caller_id, callee_name, call_node.lineno)

        # module.func() where module is an import binding
        elif (
            isinstance(func_expr, ast.Attribute)
            and isinstance(func_expr.value, ast.Name)
        ):
            obj_name = func_expr.value.id
            attr = func_expr.attr
            if obj_name in self.st.bindings:
                b = self.st.bindings[obj_name]
                if b.is_module_import:
                    res = self.resolver.resolve(b.target_module, attr)
                    self._emit_call_edge(caller_id, res, callee_name, call_node.lineno)
                    return
            # Unknown object type → dynamic-unresolved, emit nothing (soundness)
            # (We skip emitting a placeholder to avoid false edges)

        # Indirect / higher-order — explicitly dynamic-unresolved
        elif isinstance(func_expr, (ast.Subscript, ast.Call)):
            self._emit_dynamic_placeholder(caller_id, callee_name, call_node.lineno)

    def _emit_call_edge(
        self, caller_id: str, res: Resolution, callee_name: str, lineno: int
    ) -> None:
        if res.status in ("resolved", "resolved-module"):
            tgt_id = self._resolution_to_node_id(res)
            if tgt_id and tgt_id in self.graph.nodes:
                # Distinguish instantiation (class) from call (function)
                tgt_node = self.graph.nodes[tgt_id]
                edge_kind = "instantiates" if tgt_node.kind == "class" else "calls"
                self._emit_edge_resolved(caller_id, tgt_id, edge_kind, "resolved", lineno)
        elif res.status == "cycle":
            pass  # Don't emit calls edges for cycle resolutions
        else:
            # Unresolved — skip (soundness over recall)
            pass

    def _emit_dynamic_placeholder(self, caller_id: str, callee_name: str, lineno: int) -> None:
        # dynamic-unresolved: we know a call happens but can't prove the target.
        # Don't add a false edge; the UI will show these as runtime-only when traced.
        pass  # Intentionally empty — see TRD §6.4

    def _emit_edge_resolved(
        self, src: str, tgt: str, kind: str, confidence: str, lineno: int
    ) -> None:
        self._add_edge(
            src, tgt, kind, confidence,
            meta={"static": {"line": lineno}},
        )

    # ------------------------------------------------------------------
    # Name resolution within module scope
    # ------------------------------------------------------------------

    def _resolve_name_in_scope(self, name: str) -> Resolution:
        """Resolve a name via module bindings first, then direct definition lookup."""
        # Dotted name: "pkg.func" → resolve pkg first, then func
        parts = name.split(".")
        if len(parts) > 1:
            head = parts[0]
            tail = ".".join(parts[1:])
            if head in self.st.bindings:
                b = self.st.bindings[head]
                if b.is_module_import:
                    return self.resolver.resolve(b.target_module, tail)
                elif b.original_name is not None:
                    # head is an alias for something; try to resolve tail on it
                    inner = self.resolver.resolve(b.target_module, b.original_name)
                    if inner.status == "resolved" and inner.def_module:
                        return self.resolver.resolve(inner.def_module, tail)
            return Resolution(status="unresolved", reason=f"cannot resolve dotted name '{name}'")

        # Simple name
        if name in self.st.bindings:
            b = self.st.bindings[name]
            if b.is_module_import:
                return Resolution(status="resolved-module", def_module=b.target_module)
            return self.resolver.resolve(b.target_module, b.original_name or name)

        if name in self.st.definitions:
            return Resolution(
                status="resolved",
                def_module=self.module_name,
                def_qualname=name,
            )

        return Resolution(status="unresolved", reason=f"'{name}' not found in '{self.module_name}'")

    # ------------------------------------------------------------------
    # Resolution → node id
    # ------------------------------------------------------------------

    def _resolution_to_node_id(self, res: Resolution) -> Optional[str]:
        if res.status == "resolved" and res.def_module and res.def_qualname is not None:
            tgt_st = self.tables.get(res.def_module)
            if tgt_st is None:
                return None
            tgt_def = tgt_st.definitions.get(res.def_qualname)
            if tgt_def is None:
                return None
            tgt_relpath = _relpath_posix(tgt_st.file_path, self.repo_root)
            return make_node_id(tgt_def.kind, tgt_relpath, res.def_qualname)

        if res.status == "resolved-module" and res.def_module:
            tgt_info = self.module_map.modules.get(res.def_module)
            if tgt_info is None:
                return None
            tgt_relpath = _relpath_posix(tgt_info.path, self.repo_root)
            tgt_kind = "package" if tgt_info.is_package else "module"
            return make_node_id(tgt_kind, tgt_relpath, "")

        return None

    def _module_node_id(self) -> str:
        info = self.module_map.modules.get(self.module_name)
        if info is None:
            return ""
        kind = "package" if info.is_package else "module"
        return make_node_id(kind, self._relpath, "")

    # ------------------------------------------------------------------
    # Edge emission
    # ------------------------------------------------------------------

    def _add_edge(
        self,
        src: str,
        tgt: str,
        kind: str,
        confidence: str,
        meta: Optional[dict] = None,
        caveats: Optional[list[str]] = None,
    ) -> None:
        if src == tgt:
            return  # no self-loops
        eid = make_edge_id(src, tgt, kind)
        # De-duplicate: if same (src, tgt, kind) already exists, skip
        for existing in self.graph.edges:
            if existing.id == eid:
                return
        evidence: dict = {}
        if meta:
            evidence["static"] = meta
        edge = GraphEdge(
            id=eid,
            source=src,
            target=tgt,
            kind=kind,
            provenance="static",
            confidence=confidence,
            evidence=evidence,
            caveats=caveats or [],
        )
        self.graph.edges.append(edge)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _res_confidence(res: Resolution) -> str:
    if res.status in ("resolved", "resolved-module"):
        return "resolved"
    if res.status == "cycle":
        return "heuristic"
    return "dynamic-unresolved"


def _expr_to_name(node: ast.expr) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_expr_to_name(node.value)}.{node.attr}"
    if isinstance(node, ast.Call):
        return _expr_to_name(node.func)
    return "<complex>"


def _node_qualname(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) -> str:
    """Best-effort qualname reconstruction from an AST node (name only, no scope)."""
    return node.name
