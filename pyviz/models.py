"""Shared immutable data structures for all pipeline passes.

Every pass produces a new value and reads prior pass outputs — no mutations across passes.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Node / edge vocabulary
# ---------------------------------------------------------------------------

NODE_KINDS = frozenset(
    {"module", "package", "class", "function", "method", "coroutine", "variable", "external"}
)
EDGE_KINDS = frozenset({"imports", "calls", "instantiates", "inherits", "decorates", "defines"})
PROVENANCES = frozenset({"static", "runtime", "both"})
CONFIDENCES = frozenset({"resolved", "heuristic", "dynamic-unresolved"})


# ---------------------------------------------------------------------------
# P2 symbol table types
# ---------------------------------------------------------------------------


@dataclass
class Definition:
    """A symbol defined in a module — function, class, method, or variable."""

    qualname: str
    kind: str  # function | method | coroutine | class | variable
    lineno: int
    end_lineno: int
    col: int = 0
    is_async: bool = False
    method_kind: Optional[str] = None  # instance | classmethod | staticmethod
    is_abstract: bool = False
    decorator_names: list[str] = field(default_factory=list)
    bases_exprs: list[str] = field(default_factory=list)


@dataclass
class Binding:
    """A name introduced by an import statement in a module."""

    local_name: str
    target_module: str          # fully-resolved absolute dotted module name
    original_name: Optional[str]  # symbol name in target; None for bare "import x"
    is_wildcard: bool = False
    is_module_import: bool = False  # "import x [as y]" — binds the module object
    lineno: int = 0


@dataclass
class SymbolTable:
    """Everything statically known about one module after P2 parsing."""

    module_name: str
    file_path: str
    definitions: dict[str, Definition] = field(default_factory=dict)  # qualname -> Def
    bindings: dict[str, Binding] = field(default_factory=dict)        # local_name -> Binding
    wildcard_sources: list[str] = field(default_factory=list)         # modules from "from x import *"
    all_names: Optional[frozenset[str]] = None  # __all__ contents when statically known
    all_is_dynamic: bool = False


# ---------------------------------------------------------------------------
# P1 module map types
# ---------------------------------------------------------------------------


@dataclass
class ModuleInfo:
    dotted_name: str
    path: str           # absolute OS path
    is_package: bool
    is_namespace: bool
    source_root: str    # absolute OS path of the source root that contains this module


@dataclass
class ModuleMap:
    modules: dict[str, ModuleInfo] = field(default_factory=dict)  # dotted_name -> info
    by_path: dict[str, str] = field(default_factory=dict)         # abs_path -> dotted_name
    source_roots: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# P3 resolution result
# ---------------------------------------------------------------------------


@dataclass
class Resolution:
    """Result of resolving (module, name) to its true definition site."""

    status: str                     # resolved | resolved-module | unresolved | cycle | dynamic
    def_module: Optional[str] = None
    def_qualname: Optional[str] = None
    reason: Optional[str] = None
    chain: Optional[list[tuple[str, str]]] = None  # for cycle reporting


# ---------------------------------------------------------------------------
# P4 / P6 graph types
# ---------------------------------------------------------------------------


def make_node_id(kind: str, relpath: str, qualname: str) -> str:
    """Stable, deterministic 16-char hex node identity (§8.1)."""
    key = f"{kind}::{relpath}::{qualname}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def make_edge_id(source: str, target: str, kind: str) -> str:
    key = f"{source}::{target}::{kind}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


@dataclass
class GraphNode:
    id: str
    kind: str
    name: str
    qualname: str
    module: str
    file_path: str   # POSIX-normalized relative path from repo root
    line_start: int
    line_end: int
    attributes: dict = field(default_factory=dict)
    caveats: list[str] = field(default_factory=list)


@dataclass
class GraphEdge:
    id: str
    source: str      # node id
    target: str      # node id
    kind: str
    provenance: str  # static | runtime | both
    confidence: str  # resolved | heuristic | dynamic-unresolved
    evidence: dict = field(default_factory=dict)
    caveats: list[str] = field(default_factory=list)


@dataclass
class StaticGraph:
    nodes: dict[str, GraphNode] = field(default_factory=dict)  # id -> node
    edges: list[GraphEdge] = field(default_factory=list)


# ---------------------------------------------------------------------------
# P5 runtime edge
# ---------------------------------------------------------------------------


@dataclass
class RuntimeEdge:
    caller_relpath: str
    caller_qualname: str
    callee_relpath: str
    callee_qualname: str
    count: int = 1
