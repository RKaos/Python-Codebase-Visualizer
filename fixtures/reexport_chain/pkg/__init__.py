"""Re-export Thing from core — typical __init__.py pattern.

The resolver MUST trace this back to pkg.core, not stop here.
"""
from .core import Thing as Thing
from .core import helper as helper
