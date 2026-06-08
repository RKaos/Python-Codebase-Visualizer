"""True definition site for Thing and helper."""


class Thing:
    """A simple class defined here, re-exported via __init__."""

    def do(self) -> str:
        return "done"


def helper() -> int:
    return 42
