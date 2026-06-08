"""Module with dynamically-constructed __all__ — must trigger all_is_dynamic caveat."""

_base = ["Widget"]
__all__ = _base + ["helper"]  # dynamic: cannot be statically enumerated


class Widget:
    pass


def helper():
    pass
