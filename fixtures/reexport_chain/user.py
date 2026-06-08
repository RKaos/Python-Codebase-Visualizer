"""Imports Thing from the package top-level — should resolve to pkg.core."""
from pkg import Thing

obj = Thing()
result = obj.do()
