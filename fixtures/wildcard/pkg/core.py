"""Defines Widget (exported) and _internal (not exported)."""

__all__ = ["Widget"]


class Widget:
    pass


def _internal():
    """Not in __all__; should NOT be exported by the wildcard."""
    pass
