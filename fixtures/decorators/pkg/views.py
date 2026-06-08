"""Exercises plain decorator, decorator factory, and framework-registration."""


class SimpleRouter:
    def get(self, path: str):
        def decorator(fn):
            return fn
        return decorator


router = SimpleRouter()


def my_decorator(fn):
    """Plain decorator — should produce a decorates edge to get_items."""
    return fn


@my_decorator
def get_items():
    return []


@router.get("/items")
def list_items():
    """Framework-registration decorator — should be tagged framework_entrypoint."""
    return []
