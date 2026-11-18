#!/usr/bin/env python3
"""Run the CIQ-A6A verifier tests:  python3 -I scripts/merge-governance/continuity/run_tests.py

Set CIQ_A6A_REQUIRE_REPLAY=1 to fail (instead of skip) when the commits of PRs 119, 120, 122 and
124 are not available locally (CI fetches them first).
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tests"))

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(os.path.join(HERE, "tests"), pattern="test_*.py", top_level_dir=os.path.join(HERE, "tests"))
    res = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if res.wasSuccessful() else 1)
