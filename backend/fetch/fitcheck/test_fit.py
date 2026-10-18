"""Run: python backend/fetch/fitcheck/test_fit.py (or pytest)."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fit import check, rect_fits  # noqa: E402


def test_fits_both_ways():
    r = check([1.0, 0.8, 1.0], space_w=2.0, space_d=2.0)
    assert r.fits == "yes" and r.orientation == "as listed" and not r.tight, r


def test_needs_rotation():
    # 1.8 wide, 0.9 deep in a 1.2 x 2.4 nook: only turned
    r = check([1.8, 0.8, 0.9], space_w=1.2, space_d=2.4)
    assert r.fits == "yes" and r.orientation == "turned 90 degrees", r
    assert "only fits turned" in r.reasons[0]


def test_too_wide():
    r = check([2.12, 0.85, 0.95], space_w=2.0, space_d=1.0)
    assert r.fits == "no", r
    assert "2.12 m wide, your space is 2.00 m" in r.reasons[0]


def test_wall_only():
    assert check([2.1, 0.85, 0.9], space_w=2.4).fits == "yes"
    r = check([2.12, 0.85, 0.95], space_w=2.0)
    assert r.fits == "unknown" and "sticks out" in r.reasons[0], r  # sideways could work, depth unknown
    assert check([2.6, 0.85, 2.3], space_w=2.0).fits == "no"


def test_tight_front():
    r = check([2.0, 0.8, 0.9], space_w=2.4, space_d=1.0)
    assert r.fits == "yes" and r.tight and "less than the 30 cm" in r.reasons[0], r


def test_too_tall_for_ceiling():
    r = check([0.9, 2.5, 0.5], space_w=2.0, space_d=2.0, ceiling=2.4)
    assert r.fits == "no" and "2.50 m tall, your ceiling is 2.40 m" in r.reasons[0], r


def test_door_upright():
    # 2.1 x 0.85 x 0.9 sofa through a 0.9 x 2.0 door, end first
    r = check([2.1, 0.85, 0.9], door_w=0.9, door_h=2.0)
    assert r.fits == "yes" and r.door_orientation == "end first" and "5 cm to spare" in r.reasons[0], r


def test_door_upright_clear():
    r = check([2.1, 0.80, 0.85], door_w=0.9, door_h=2.0)
    assert r.fits == "yes" and r.door_orientation == "end first", r


def test_door_needs_tilt():
    # 2.1 x 2.2 tabletop, 5 cm thick: both long sides beat the 2.0 m door, slips through diagonally
    assert rect_fits(2.1, 0.05, 0.8, 2.0)[1] == "tilted"
    r = check([2.2, 0.05, 2.1], door_w=0.8, door_h=2.0)
    assert r.fits == "yes" and r.door_orientation.startswith("tilted"), r


def test_door_impossible():
    r = check([2.2, 1.0, 1.1], door_w=0.8, door_h=2.0)
    assert r.fits == "no" and "No way through" in r.reasons[0], r
    # thick slab too: diagonal needs a wider door
    assert check([2.2, 0.4, 2.1], door_w=0.8, door_h=2.0).fits == "no"


def test_door_legs_off():
    # 0.88 high with 12 cm legs through a 0.80 wide door
    r = check([2.1, 0.88, 0.95], door_w=0.8, door_h=2.0)
    assert r.fits == "unknown" and "legs off" in r.reasons[0], r


def test_missing_dims():
    assert check(None, space_w=2.0).fits == "unknown"
    assert check([2.0, None, 0.9], space_w=2.4).fits == "yes"  # footprint only needs w and d
    r = check([2.0, None, 0.9], ceiling=2.4)
    assert r.fits == "unknown" and "height" in r.reasons[0], r
    assert check([2.0, 0.8, 0.9]).fits == "unknown"  # no space at all


def test_borderline():
    assert check([1.99, 0.8, 0.9], space_w=2.0).fits == "unknown"
    assert check([2.01, 0.8, 0.9], space_w=2.0, space_d=1.0).fits == "unknown"
    assert check([0.9, 2.39, 0.5], ceiling=2.4).fits == "unknown"
    assert check([2.1, 0.79, 0.9], door_w=0.8, door_h=2.0).fits == "unknown"


def test_worst_wins():
    r = check([2.1, 0.85, 0.9], space_w=2.4, space_d=3.0, door_w=0.7, door_h=2.0)
    assert r.fits in ("no", "unknown") and r.checks[0].verdict == "yes"


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as e:
                failed += 1
                print(f"FAIL {name}: {e}")
    sys.exit(1 if failed else 0)
