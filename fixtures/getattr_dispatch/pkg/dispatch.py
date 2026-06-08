"""getattr-based dispatch — static analysis cannot resolve the callee.

The call to getattr(handler, action)() is dynamic-unresolved statically.
Runtime tracing recovers it.
"""


class Handler:
    def process(self):
        return "processed"

    def validate(self):
        return "valid"


def dispatch(handler: Handler, action: str):
    method = getattr(handler, action)
    return method()  # dynamic-unresolved: static analysis stops here
