"""Reproduce the Class D and E audit using Python's standard library."""

from collections import Counter
from fractions import Fraction
from functools import cache
from itertools import combinations, pairwise
from math import factorial, prod
from pathlib import Path
import json


def natural(h):
    return bool(h) and h[-1] >= 1 and all(x - y >= 2 for x, y in pairwise(h))


def gaps(h):
    return tuple(x - y for x, y in pairwise(h))


def e_index(h):
    indices = [i for i, g in enumerate(gaps(h)) if g == 3]
    if len(indices) == 1 and 1 <= indices[0] <= len(h) - 3:
        return indices[0]
    return None


def pair_factor(u, v):
    e = (u - v) % 2
    return Fraction((u - v) ** 2 - e, (u + v) ** 2 - e)


@cache
def weight(h):
    denominator = prod(x * factorial(x // 2) * factorial((x - 1) // 2) for x in h)
    return Fraction(1, denominator) * prod(pair_factor(x, y) for x, y in combinations(h, 2))


@cache
def ordinary_dimension(h):
    # Construct the diagram as a union of its balanced diagonal hooks.
    cells = set()
    for i, x in enumerate(h):
        arm, leg = x // 2, (x - 1) // 2
        cells.update((i, i + j) for j in range(arm + 1))
        cells.update((i + j, i) for j in range(1, leg + 1))
    rows = Counter(i for i, _ in cells)
    cols = Counter(j for _, j in cells)
    assert len(cells) == sum(h)
    assert all(j < rows[i] and i < cols[j] for i, j in cells), h
    hook_product = prod(rows[i] + cols[j] - i - j - 1 for i, j in cells)
    dimension, remainder = divmod(factorial(len(cells)), hook_product)
    assert dimension > 0 and remainder == 0, h
    return dimension


def checked_ratio(h, target):
    assert natural(h) and natural(target) and sum(h) == sum(target), (h, target)
    ratio = weight(target) / weight(h)
    ordinary_ratio = Fraction(ordinary_dimension(target), ordinary_dimension(h))
    assert ratio == ordinary_ratio, (h, target, ratio, ordinary_ratio)
    return ratio


def transfer(h, donor, recipient):
    target = list(h)
    target[donor] -= 1
    target[recipient] += 1
    return tuple(target)


def e_moves(h, k):
    moves = [(k + 1, k), (len(h) - 1, 0), (-2, -1), (0, 1), (2, 0)]
    targets = [transfer(h, donor, recipient) for donor, recipient in moves]
    targets.append((h[0] + h[-1], *h[1:-1]))
    return targets


def has_witness(h, targets):
    return any(checked_ratio(h, target) > 1 for target in targets if natural(target))


def verify_regressions():
    path = Path(__file__).with_name("de_regression.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    comparisons = 0
    for case in data["cases"]:
        h = tuple(case["h"])
        assert all(key in data["sources"] for key, _ in case["refs"]), case["id"]
        assert min(gaps(h)) == 3 and gaps(h).count(3) == 1, h
        if case["domain"] == "D":
            assert len(h) >= 4 and 2 <= h[-1] <= 18 and gaps(h)[-1] == 3, h
        else:
            assert case["domain"] == "E" and e_index(h) is not None, h
        for check in case["targets"]:
            target = tuple(check["h"])
            actual = checked_ratio(h, target)
            expected = Fraction(check["expected"])
            assert actual == expected, (case["id"], check["move"], actual, expected)
            comparisons += 1
    return len(data["cases"]), comparisons


def verify_rank_four_residuals():
    count_d = 0
    for y in range(10, 16):
        for x in range(y + 4, 27):
            h = (x, y, 6, 3)
            moves = [(3, 0), (3, 1), (0, 1), (1, 2)]
            assert has_witness(h, [transfer(h, i, j) for i, j in moves]), h
            count_d += 1

    count_e = 0
    for a in range(8, 13):
        for z in range(1, a - 6):
            for x in range(a + 4, 22):
                h = (x, a, a - 3, z)
                assert has_witness(h, e_moves(h, 1)), h
                count_e += 1

    assert (count_d, count_e) == (63, 110)
    return count_d, count_e


def natural_sequences(n, minimum=1):
    for last in range(minimum, n + 1):
        if last == n:
            yield (last,)
        else:
            for upper in natural_sequences(n - last, last + 2):
                yield (*upper, last)


def verify_small_e():
    all_count = pure_count = 0
    for n in range(1, 46):
        for h in natural_sequences(n):
            k = e_index(h)
            if k is None:
                continue
            assert has_witness(h, e_moves(h, k)), h
            all_count += 1
            pure_count += min(gaps(h)) == 3
    assert (all_count, pure_count) == (595, 187)
    return all_count, pure_count


def verify_r6_family_examples():
    for r in (8, 16, 64):
        dense = tuple(range(4 * r - 2, 1, -4))
        h = (dense[0] - 1, dense[1] - 1, *dense[2:])
        assert h[0] == 4 * r - 3 and h[-1] == 2 and sum(h) == 2 * r * r - 2
        assert e_index(h) == 1 and gaps(h).count(4) == r - 2
        assert h[0] > 6 * h[-1] and gaps(h)[0] == gaps(h)[-1] == 4


if __name__ == "__main__":
    cases, comparisons = verify_regressions()
    d, e = verify_rank_four_residuals()
    all_e, pure_e = verify_small_e()
    verify_r6_family_examples()
    print(f"Exact regression: {cases} source sequences, {comparisons} legal target ratios.")
    print(f"Rank-four residuals: D(d=3) {d}/{d}, E {e}/{e} covered.")
    print(f"E for n <= 45: {all_e}/{all_e}, including {pure_e}/{pure_e} pure cases.")
    print("R6 family shape checked at ranks 8, 16, and 64.")
