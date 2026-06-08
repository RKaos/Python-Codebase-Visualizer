from .a import X as X  # cycle: a imports b imports a


class X:
    pass
