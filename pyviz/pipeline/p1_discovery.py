"""P1 — Discovery: walk the repo and build a ModuleMap.

Output: ModuleMap { modules, by_path, source_roots }
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from pyviz.models import ModuleInfo, ModuleMap


def discover(repo_path: str, source_root_override: Optional[str] = None) -> ModuleMap:
    """Entry point for P1."""
    repo = Path(repo_path).resolve()

    if source_root_override:
        source_roots = [Path(source_root_override).resolve()]
    else:
        source_roots = _detect_source_roots(repo)

    module_map = ModuleMap(source_roots=[str(r) for r in source_roots])

    for sr in source_roots:
        _walk_root(sr, module_map)

    return module_map


# ---------------------------------------------------------------------------
# Source-root detection
# ---------------------------------------------------------------------------


def _detect_source_roots(repo: Path) -> list[Path]:
    """Detect source roots. Prefer src/ layout; fall back to flat."""
    # 1. Check for explicit pyproject.toml package-dir hint (simplified: honour src/ presence)
    src_dir = repo / "src"
    if src_dir.is_dir() and _has_python_content(src_dir):
        return [src_dir]

    # 2. Flat layout — any top-level package directories
    if _has_python_content(repo):
        return [repo]

    return [repo]


def _has_python_content(directory: Path) -> bool:
    """True if directory contains any package or Python file."""
    try:
        for item in directory.iterdir():
            if item.is_dir() and (item / "__init__.py").exists():
                return True
            if item.is_file() and item.suffix == ".py":
                return True
    except PermissionError:
        pass
    return False


# ---------------------------------------------------------------------------
# Module tree walk
# ---------------------------------------------------------------------------


def _walk_root(source_root: Path, module_map: ModuleMap) -> None:
    """Walk a source root and register all modules/packages."""
    try:
        entries = sorted(source_root.iterdir())
    except PermissionError:
        return

    for item in entries:
        if _should_skip(item):
            continue
        if item.is_dir():
            if (item / "__init__.py").exists():
                _walk_package(item, item.name, source_root, module_map)
            elif _could_be_namespace(item):
                _walk_namespace(item, item.name, source_root, module_map)
        elif item.is_file() and item.suffix == ".py" and item.stem != "__init__":
            _register(item.stem, item, False, False, source_root, module_map)


def _walk_package(
    directory: Path,
    dotted: str,
    source_root: Path,
    module_map: ModuleMap,
) -> None:
    """Register a regular package and recurse into its contents."""
    init_file = directory / "__init__.py"
    _register(dotted, init_file, True, False, source_root, module_map)

    try:
        entries = sorted(directory.iterdir())
    except PermissionError:
        return

    for item in entries:
        if _should_skip(item):
            continue
        child_dotted = f"{dotted}.{item.name}"
        if item.is_dir():
            if (item / "__init__.py").exists():
                _walk_package(item, child_dotted, source_root, module_map)
            elif _could_be_namespace(item):
                _walk_namespace(item, child_dotted, source_root, module_map)
        elif item.is_file() and item.suffix == ".py" and item.stem != "__init__":
            mod_dotted = f"{dotted}.{item.stem}"
            _register(mod_dotted, item, False, False, source_root, module_map)


def _walk_namespace(
    directory: Path,
    dotted: str,
    source_root: Path,
    module_map: ModuleMap,
) -> None:
    """Walk a namespace package (PEP 420 — no __init__.py)."""
    try:
        entries = sorted(directory.iterdir())
    except PermissionError:
        return

    for item in entries:
        if _should_skip(item):
            continue
        child_dotted = f"{dotted}.{item.name}"
        if item.is_dir():
            if (item / "__init__.py").exists():
                _walk_package(item, child_dotted, source_root, module_map)
        elif item.is_file() and item.suffix == ".py" and item.stem != "__init__":
            mod_dotted = f"{dotted}.{item.stem}"
            _register(mod_dotted, item, False, True, source_root, module_map)


def _register(
    dotted: str,
    path: Path,
    is_package: bool,
    is_namespace: bool,
    source_root: Path,
    module_map: ModuleMap,
) -> None:
    info = ModuleInfo(
        dotted_name=dotted,
        path=str(path),
        is_package=is_package,
        is_namespace=is_namespace,
        source_root=str(source_root),
    )
    module_map.modules[dotted] = info
    module_map.by_path[str(path)] = dotted


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_SKIP_DIRS = frozenset(
    {
        "__pycache__",
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        ".tox",
        ".venv",
        "venv",
        ".env",
        "env",
        "build",
        "dist",
        ".eggs",
        "*.egg-info",
    }
)


def _should_skip(path: Path) -> bool:
    name = path.name
    if name.startswith("."):
        return True
    if name in _SKIP_DIRS:
        return True
    if name.endswith(".egg-info"):
        return True
    return False


def _could_be_namespace(directory: Path) -> bool:
    """Heuristic: if a dir has any .py files it might be a namespace package."""
    try:
        return any(f.suffix == ".py" for f in directory.iterdir() if f.is_file())
    except PermissionError:
        return False
