"""Recheck archived fiber and energy examples using only the standard library."""

import json
import math
from fractions import Fraction
from itertools import product
from pathlib import Path


def fiber_gaps(hooks):
    return tuple(a - b - 2 for a, b in zip(hooks, hooks[1:])) + (hooks[-1] - 1,)


def shape_from_arms_legs(arms, legs):
    rows = [0] * (legs[0] + 1)
    for index, (arm, leg) in enumerate(zip(arms, legs)):
        rows[index] += arm + 1
        for row in range(index + 1, index + 1 + leg):
            rows[row] += 1
    assert all(a >= b > 0 for a, b in zip(rows, rows[1:]))
    return tuple(rows)


def balanced_shape(hooks):
    arms = tuple(hook // 2 for hook in hooks)
    legs = tuple((hook - 1) // 2 for hook in hooks)
    shape = shape_from_arms_legs(arms, legs)
    assert sum(shape) == sum(hooks)
    return shape


def hook_degree(shape, n_factorial):
    columns = [sum(width > column for width in shape) for column in range(shape[0])]
    product_of_hooks = math.prod(
        width - column + columns[column] - row - 1
        for row, width in enumerate(shape)
        for column in range(width)
    )
    degree, remainder = divmod(n_factorial, product_of_hooks)
    assert remainder == 0
    return degree


def fiber_weight_matrix(hooks):
    gaps = fiber_gaps(hooks)
    rank = len(hooks)
    n_factorial = math.factorial(sum(hooks))
    weights = {}
    for coordinates in product(*(range(gap + 1) for gap in gaps)):
        arms = tuple(rank - i - 1 + sum(coordinates[i:]) for i in range(rank))
        legs = tuple(hook - 1 - arm for hook, arm in zip(hooks, arms))
        weights[coordinates] = hook_degree(shape_from_arms_legs(arms, legs), n_factorial) ** 2
    return weights


def weighted_slack(total, rank):
    if rank == 1:
        yield (total,)
        return
    for last in range(total // rank + 1):
        for prefix in weighted_slack(total - rank * last, rank - 1):
            yield prefix + (last,)


def hook_vectors(n, gap):
    rank = 1
    while (base := rank + gap * rank * (rank - 1) // 2) <= n:
        for slack in weighted_slack(n - base, rank):
            yield tuple(1 + gap * (rank - i - 1) + sum(slack[i:]) for i in range(rank))
        rank += 1


def check_small_fibers():
    weights = fiber_weight_matrix((5, 2))
    matrix = [[weights[i, j] for j in range(2)] for i in range(2)]
    assert matrix == [[196, 441], [441, 196]]
    assert matrix[0][0] * matrix[1][1] != matrix[0][1] * matrix[1][0]

    hook_weights = fiber_weight_matrix((7,))
    ratio = Fraction(sum(hook_weights.values()), sum(weights.values()))
    false_lower_bound = Fraction(max(hook_weights.values()), max(weights.values()))
    assert ratio == Fraction(462, 637)
    assert ratio < false_lower_bound == Fraction(400, 441)
    return {
        "hooks_5_2_weights": matrix,
        "mass_ratio_7_to_5_2": str(ratio),
        "incorrect_lower_bound_without_fiber_size": str(false_lower_bound),
    }


def check_certificate_samples(certificate_rows):
    results = {}
    for n, source in certificate_rows.items():
        n = int(n)
        hooks = tuple(source["maximizing_h"])
        n_factorial = math.factorial(n)
        degree = hook_degree(balanced_shape(hooks), n_factorial)
        assert degree == int(source["max_degree"])
        size = math.prod(gap + 1 for gap in fiber_gaps(hooks))
        point_mass = Fraction(degree**2, n_factorial)
        normalized_deficit = (math.lgamma(n + 1) / 2 - math.log(degree)) / math.sqrt(n)
        results[n] = {
            "maximizing_h": hooks,
            "degree": str(degree),
            "fiber_size": size,
            "point_mass": str(point_mass),
            "point_mass_decimal": float(point_mass),
            "fiber_mass_upper_bound": str(size * point_mass),
            "fiber_mass_upper_bound_decimal": float(size * point_mass),
            "max_log_deficit_over_sqrt_n": normalized_deficit,
        }

    assert results[6]["degree"] == "16"
    assert results[15]["degree"] == "292864"
    assert results[47]["fiber_size"] == 135
    assert math.prod(gap + 1 for gap in fiber_gaps((19, 15, 11, 2))) == 144
    assert results[200]["fiber_size"] == 340200
    assert results[200]["fiber_mass_upper_bound_decimal"] > results[150]["fiber_mass_upper_bound_decimal"]
    assert results[345]["max_log_deficit_over_sqrt_n"] > results[350]["max_log_deficit_over_sqrt_n"]
    return results


def check_gap_three_family(certificate_rows, archived_results):
    results = {}
    for n in (50, 60, 70, 80):
        n_factorial = math.factorial(n)
        lower_numerator = upper_numerator = 0
        count = count_gap_three = best_degree = 0
        best_hooks = ()
        max_degree = 0
        for hooks in hook_vectors(n, gap=3):
            count += 1
            degree = hook_degree(balanced_shape(hooks), n_factorial)
            max_degree = max(max_degree, degree)
            if 3 in (a - b for a, b in zip(hooks, hooks[1:])):
                count_gap_three += 1
                lower_numerator += degree**2
                upper_numerator += degree**2 * math.prod(gap + 1 for gap in fiber_gaps(hooks))
                if degree > best_degree:
                    best_degree, best_hooks = degree, hooks

        lower = Fraction(lower_numerator, n_factorial)
        upper = Fraction(upper_numerator, n_factorial)
        expected = archived_results[str(n)]
        assert max_degree == int(certificate_rows[str(n)]["max_degree"])
        assert count == expected["total_count"]
        assert count_gap_three == expected["gap_three_count"]
        assert best_hooks == tuple(expected["best_hooks"])
        assert Fraction(best_degree, max_degree) == Fraction(expected["degree_ratio"])
        assert lower == Fraction(expected["lower"])
        assert upper == Fraction(expected["upper"])
        assert 0 < lower < 1 < upper
        results[n] = {
            "total_count": count,
            "gap_three_count": count_gap_three,
            "best_hooks": best_hooks,
            "degree_ratio": str(Fraction(best_degree, max_degree)),
            "max_log_deficit_over_sqrt_n": (math.log(max_degree) - math.log(best_degree)) / math.sqrt(n),
            "lower_bound": str(lower),
            "lower_bound_decimal": float(lower),
            "summed_upper_bound": str(upper),
            "summed_upper_bound_decimal": float(upper),
        }
    return results


def uniform_excess(u):
    scale = math.pi / math.sqrt(6)
    return 2 / scale * math.log1p(math.exp(-scale * abs(u)))


def profile_discrepancy(u):
    u = abs(u)
    if u >= 2:
        return uniform_excess(u)
    vk_profile = 2 / math.pi * (u * math.asin(u / 2) + math.sqrt(4 - u * u))
    return u + uniform_excess(u) - vk_profile


def midpoint_energy(box_half_width, grid_count):
    step = 2 * box_half_width / grid_count
    values = [profile_discrepancy(-box_half_width + (i + 0.5) * step) for i in range(grid_count)]
    return 2 * math.fsum(
        ((values[i] - values[j]) / (i - j)) ** 2
        for i in range(grid_count)
        for j in range(i)
    )


def check_energy(archived_results):
    results = []
    for case in archived_results:
        width, grid = case["box_half_width"], case["grid_count"]
        energy = midpoint_energy(width, grid)
        assert math.isclose(energy, case["energy"], rel_tol=0, abs_tol=1e-9)
        results.append({
            "box_half_width": width,
            "grid_count": grid,
            "energy": energy,
            "energy_over_16": energy / 16,
        })
    assert uniform_excess(3) > 0
    return results


def main():
    fixtures = json.loads(Path(__file__).with_name("fixtures.json").read_text(encoding="utf-8"))
    print(json.dumps({
        "small_fibers": check_small_fibers(),
        "certificate_samples": check_certificate_samples(fixtures["certificate_rows"]),
        "gap_three_families": check_gap_three_family(fixtures["certificate_rows"], fixtures["gap_three_families"]),
        "finite_box_midpoint_energies": check_energy(fixtures["finite_box_midpoint_energies"]),
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
