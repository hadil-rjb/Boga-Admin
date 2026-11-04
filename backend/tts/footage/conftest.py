import os
import sys

# Let tests import cube / color / grade as top-level modules, the same way
# `python grade.py ...` resolves them when run as a script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
