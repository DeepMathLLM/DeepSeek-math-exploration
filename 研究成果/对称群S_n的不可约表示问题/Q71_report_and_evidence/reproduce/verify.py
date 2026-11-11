"""Independently verify finite tables, collision witnesses and regression inputs."""

import argparse
from collections import Counter
from fractions import Fraction
from functools import cache
import json
from math import factorial, prod
from pathlib import Path
import subprocess


HERE = Path(__file__).resolve().parent
COUNTS = ("domain_count", "strictly_pruned", "exact_leaves", "nodes")


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def gaps(h):
    return tuple(x - y for x, y in zip(h, h[1:]))


def valid_hooks(h, n, gap):
    return bool(h) and all(type(x) is int and x > 0 for x in h) and sum(h) == n and min(gaps(h), default=gap) >= gap


def valid_shape(p):
    return bool(p) and all(type(x) is int and x > 0 for x in p) and all(x >= y for x, y in zip(p, p[1:]))


def conjugate(p):
    return tuple(sum(row >= j for row in p) for j in range(1, p[0] + 1))


def main_hooks(p):
    return tuple(x + y - 2 * i - 1 for i, (x, y) in enumerate(zip(p, conjugate(p))) if x > i)


@cache
def balanced(h):
    # Assemble the diagonal hooks as actual Ferrers cells independently of JS.
    cells = set()
    for i, x in enumerate(h):
        cells.update((i, i + j) for j in range(x // 2 + 1))
        cells.update((i + j, i) for j in range(1, (x - 1) // 2 + 1))
    assert len(cells) == sum(h)
    lengths = Counter(i for i, _ in cells)
    p = tuple(lengths[i] for i in range(len(lengths)))
    assert valid_shape(p) and cells == {(i, j) for i, row in enumerate(p) for j in range(row)}
    return p


@cache
def degree(p):
    assert valid_shape(p), p
    columns = conjugate(p)
    hook_product = prod(x - j + columns[j] - i - 1 for i, x in enumerate(p) for j in range(x))
    d, rem = divmod(factorial(sum(p)), hook_product)
    assert d > 0 and rem == 0
    return d


def dim(h):
    return degree(balanced(tuple(h)))


def partitions(n, cap):
    if n == 0:
        yield ()
    for x in range(min(n, cap), 0, -1):
        for tail in partitions(n - x, x):
            yield (x, *tail)


def hook_sequences(n, rank, gap, bottom=1):
    # Enumerate the smallest hook first, directly in hook coordinates.
    if rank == 1:
        if n >= bottom:
            yield (n,)
        return
    maximum_bottom = (n - gap * rank * (rank - 1) // 2) // rank
    for last in range(bottom, maximum_bottom + 1):
        for prefix in hook_sequences(n - last, rank - 1, gap, last + gap):
            yield (*prefix, last)


def partition_counts(limit):
    # Multiply the truncated series (1-z**k)**(-1), a factor for each part size.
    table = [[1] + [0] * limit]
    for part in range(1, limit + 1):
        row = [0] * (limit + 1)
        for previous, coefficient in enumerate(table[-1]):
            if coefficient:
                for power in range(previous, limit + 1, part):
                    row[power] += coefficient
        table.append(row)
    return table


def slack(n, r, gap):
    return n - r - gap * r * (r - 1) // 2


def check_coverage(stat, expected):
    domain, pruned, leaves, nodes = (stat[k] for k in COUNTS)
    assert all(type(stat[k]) is int and stat[k] >= 0 for k in COUNTS)
    assert domain == expected == pruned + leaves and nodes >= leaves, stat


def check_maxima(row, n, gap, rank=None):
    raw = row["max_degree"]
    assert isinstance(raw, str) and raw.isascii() and raw.isdecimal() and raw[0] != "0", raw
    d = int(raw)
    hs = [tuple(h) for h in row["maximizing_h"]]
    assert hs and hs == sorted(set(hs))
    assert all(valid_hooks(h, n, gap) and (rank is None or len(h) == rank) for h in hs)
    assert row["min_gap"] == min((x for h in hs for x in gaps(h)), default=None)
    assert row["conjugacy_classes"] == len(hs)
    expected = sorted({p for h in hs for p in (balanced(h), conjugate(balanced(h)))})
    assert list(map(tuple, row["maximizing_partitions"])) == expected
    assert row["partition_count"] == len(expected)
    assert all(sum(p) == n and main_hooks(p) in hs and degree(p) == d for p in expected)
    return d, hs, expected


def check_ranks(rows, n, gap, counts):
    ranks = [r for r in range(1, n + 1) if slack(n, r, gap) >= 0]
    assert [row["rank"] for row in rows] == ranks
    for row in rows:
        r = row["rank"]
        check_coverage(row, counts[r][slack(n, r, gap)])


def totals(rows):
    return {key: sum(row[key] for row in rows) for key in (*COUNTS, "conjugacy_classes", "partition_count")}


def check_tables(directory, counts):
    files = ("natural_maxima_1_350.json", "rank_profile_gap4_1_350.json")
    natural, profile = (read(directory / name) for name in files)
    for table, gap, scope in ((natural, 2, "global"), (profile, 4, "rank")):
        assert (table["first"], table["last"], table["gap"], table["scope"]) == (1, 350, gap, scope)
        assert list(map(int, table["rows"])) == list(range(1, 351))
    natural, profile = natural["rows"], profile["rows"]
    rank_changes, restricted_rows, old_restrictions = [], [], Counter()
    old_peak = 0
    for key, global_row in natural.items():
        n = int(key)
        d, hs, _ = check_maxima(global_row, n, 2)
        assert len(hs) == 1 and min(gaps(hs[0]), default=4) >= 4
        check_ranks(global_row["rank_coverage"], n, 2, counts)
        assert all(global_row[k] == sum(s[k] for s in global_row["rank_coverage"]) for k in COUNTS)
        assert global_row["exact_leaves"] >= len(hs)

        group = profile[key]
        rows = group["ranks"]
        check_ranks(rows, n, 4, counts)
        values = []
        for row in rows:
            r = row["rank"]
            value, hs_r, _ = check_maxima(row, n, 4, r)
            assert len(hs_r) == 1 and row["exact_leaves"] >= len(hs_r)
            values.append(value)
            if slack(n, r, 4) > 40:
                step_sizes = gaps(hs_r[0])
                exceeds_cap = hs_r[0][-1] > 20
                violates_order = any(a < b for a, b in zip(step_sizes, step_sizes[1:]))
                old_restrictions["cap"] += exceeds_cap
                old_restrictions["monotonicity"] += violates_order
                old_restrictions["union"] += exceeds_cap or violates_order
        peak = values.index(max(values))
        assert [i + 1 for i, v in enumerate(values) if v == values[peak]] == group["peak_ranks"] == [peak + 1]
        assert all(a < b for a, b in zip(values[:peak], values[1:peak+1]))
        assert all(a > b for a, b in zip(values[peak:], values[peak+1:]))
        assert all(b * b > a * c for a, b, c in zip(values, values[1:], values[2:]))
        assert group["strictly_unimodal"] and group["strictly_log_concave"]
        assert d == values[peak] and hs == list(map(tuple, rows[peak]["maximizing_h"]))
        assert peak + 1 >= old_peak
        if peak + 1 != old_peak:
            rank_changes.append({"n":n, "rank":peak + 1, "h":hs[0]})
        old_peak = peak + 1
        restricted_rows.extend(rows)
    assert len(restricted_rows) == 3016
    return natural, profile, {
        "natural_1_200": totals([natural[str(n)] for n in range(1, 201)]),
        "natural_201_350": totals([natural[str(n)] for n in range(201, 351)]),
        "gap4_rank_1_350": {"groups":len(restricted_rows), **totals(restricted_rows)},
        "every_n_strictly_unimodal_and_strictly_log_concave_in_gap4": True,
        "peak_rank_changes": rank_changes,
        "old_large_slack_constraints_excluding_rank_winner": dict(old_restrictions),
    }


def exhaustive_partitions(counts):
    all_n = {}
    for n in range(1, 36):
        groups = {}
        number = 0
        for shape in partitions(n, n):
            number += 1
            h = main_hooks(shape)
            d = degree(shape)
            keys = [(2, 0), (2, len(h))]
            if valid_hooks(h, n, 4):
                keys.append((4, len(h)))
            for key in keys:
                record = groups.setdefault(key, {"domain":set(), "max":0, "shapes":set()})
                record["domain"].add(h)
                if d > record["max"]:
                    record["max"] = d
                    record["shapes"].clear()
                if d == record["max"]:
                    record["shapes"].add(shape)
        assert number == counts[n][n]
        all_n[n] = groups
    return all_n


def check_samples(node, counts, natural, profiles):
    actual = json.loads(subprocess.check_output([node, str(HERE / "sample-search.mjs")], encoding="utf-8"))
    all_n = exhaustive_partitions(counts)
    comparisons = 0
    assert [(a["gap"], a["scope"]) for a in actual["small"]] == [(2, "global"), (2, "rank"), (4, "rank")] * 2
    for run in actual["small"]:
        gap, scope = run["gap"], run["scope"]
        assert list(map(int, run["rows"])) == list(all_n)
        for key, row in run["rows"].items():
            n = int(key)
            rows = [row] if scope == "global" else row["ranks"]
            ranks = [r for g, r in all_n[n] if g == gap and bool(r) == (scope == "rank")]
            assert sorted(ranks) == sorted(record.get("rank", 0) for record in rows)
            for record in rows:
                expected = all_n[n][gap, record.get("rank", 0)]
                d, hs, shapes = check_maxima(record, n, gap, record.get("rank"))
                assert d == expected["max"] and set(shapes) == expected["shapes"]
                assert set(hs) == {main_hooks(p) for p in expected["shapes"]}
                assert record["domain_count"] == len(expected["domain"])
                comparisons += 1
    for n, groups in all_n.items():
        d, _, shapes = check_maxima(natural[str(n)], n, 2)
        assert (d, set(shapes)) == (groups[2, 0]["max"], groups[2, 0]["shapes"])
        for row in profiles[str(n)]["ranks"]:
            r = row["rank"]
            d, _, shapes = check_maxima(row, n, 4, r)
            assert (d, set(shapes)) == (groups[4, r]["max"], groups[4, r]["shapes"])

    tie_results = []
    for fixture, result in zip(read(HERE / "inputs/ties.json"), actual["ties"], strict=True):
        n = fixture["n"]
        options = set()
        for (base, rem, _), stat in zip(fixture["domains"], result["stats"], strict=True):
            domain = {
                tuple(x + y for x, y in zip(base, p + (0,) * (len(base) - len(p)), strict=True))
                for p in partitions(rem, rem) if len(p) <= len(base)
            }
            assert domain.isdisjoint(options) and stat["domain_count"] == stat["exact_leaves"] == len(domain)
            options.update(domain)
        d, hs, shapes = check_maxima(result, n, 2)
        assert len(options) == 2 and set(hs) == options and {dim(h) for h in options} == {d}
        tie_results.append({"n":n, "degree":str(d), "maximizing_h":hs, "partitions":shapes})

    selected = [(6, 2), (15, 3), (28, 4), (47, 4), (47, 5), (69, 4), (69, 5), (69, 6),
                (71, 5), (71, 6), (201, 10), (214, 10), (263, 11), (279, 12), (350, 13)]
    boundary = []
    for n, r in selected:
        values = {h:dim(h) for h in hook_sequences(n, r, 4)}
        row = profiles[str(n)]["ranks"][r - 1]
        d, hs, _ = check_maxima(row, n, 4, r)
        assert max(values.values()) == d and set(hs) == {h for h, value in values.items() if value == d}
        assert row["domain_count"] == len(values)
        boundary.append({"n":n, "rank":r, "domain_count":len(values), "max_degree":str(d), "maximizing_h":hs})
    return {
        "ordinary_partitions_n_1_35":sum(counts[n][n] for n in all_n),
        "ordinary_partition_comparisons":comparisons,
        "exact_tie_fixtures":tie_results,
        "direct_bottom_up_rank_groups":boundary,
    }


def pad(p, q):
    width = max(len(p), len(q))
    return p + (0,) * (width - len(p)), q + (0,) * (width - len(q))


def after_step(p, q, step, n, initial):
    assert sum(step) == 0 and len(p) == len(q) == len(step)
    a = tuple(x + s for x, s in zip(p, step))
    b = tuple(x - s for x, s in zip(q, step))
    for shape in (a, b):
        assert sum(shape) == n and shape[-1] >= 0 and all(x >= y for x, y in zip(shape, shape[1:]))
    d_a = degree(tuple(x for x in a if x))
    d_b = degree(tuple(x for x in b if x))
    assert d_a * d_b > initial * initial


def proper_layer_sums(delta):
    layers = [tuple(i for i, x in enumerate(delta) if x >= depth) for depth in range(1, max(delta) + 1)]
    sums = {0: ()}
    for layer in layers:
        for total, picked in tuple(sums.items()):
            sums.setdefault(total + len(layer), (*picked, layer))
    del sums[0], sums[sum(map(len, layers))]
    return sums


def layer_check(p, q, n, d):
    p, q = pad(p, q)
    delta = tuple(y - x for x, y in zip(p, q))
    assert any(delta) and sum(delta) == 0
    positive, negative = proper_layer_sums(delta), proper_layer_sums(tuple(-x for x in delta))
    common = set(positive) & set(negative)
    if not common:
        return False
    size = min(common)
    pos = Counter(i for layer in positive[size] for i in layer)
    neg = Counter(i for layer in negative[size] for i in layer)
    after_step(p, q, tuple(pos[i] - neg[i] for i in range(len(delta))), n, d)
    return True


def check_collisions(natural):
    fixture = read(HERE / "inputs/collisions.json")
    pairs, supplied = fixture["pairs"], fixture["supplied_moves"]
    pairs_seen, gap4_primitive, covered = set(), [], set()
    counts = Counter()
    for row in pairs:
        n, h, k = row["n"], tuple(row["h1"]), tuple(row["h2"])
        assert h != k and (n, *sorted((h, k))) not in pairs_seen
        pairs_seen.add((n, *sorted((h, k))))
        generator_gap = 2 if n <= 80 else 3
        assert valid_hooks(h, n, generator_gap) and valid_hooks(k, n, generator_gap)
        p, q = balanced(h), balanced(k)
        assert p != q and p != conjugate(q)
        d = degree(p)
        assert d == degree(q) and Fraction(d, factorial(n)) == Fraction(row["W"])
        p_t, q_t = conjugate(p), conjugate(q)
        assert degree(p_t) == degree(q_t) == d
        orientations = ((p, q), (p, q_t), (p_t, q), (p_t, q_t))
        separable = [layer_check(a, b, n, d) for a, b in orientations]
        assert separable == row["separable"]
        if separable[0]:
            counts["directly_separable"] += 1
            step = row["source_step"]
            after_step(q + (0,) * (len(step) - len(q)), p + (0,) * (len(step) - len(p)), step, n, d)
        elif any(separable):
            counts["primitive_directly_separable_in_another_orientation"] += 1
        else:
            counts["primitive_in_all_orientations"] += 1
            minimum = min((*gaps(h), *gaps(k)), default=n)
            counts[f"all_orientation_primitive_minimum_gap_{min(minimum, 4)}"] += 1
            if minimum >= 4:
                gap4_primitive.append((n, h, k))
        strict_h = tuple(row["certified_competitor"])
        assert valid_hooks(strict_h, n, 2) and list(strict_h) in natural[str(n)]["maximizing_h"]
        strict_ratio = Fraction(dim(strict_h), d)
        assert strict_ratio == Fraction(row["certified_competitor_ratio"]) and strict_ratio > 1
        counts["strict_competitor_ratios_checked"] += 1
    assert len(pairs_seen) == 719
    assert (counts["directly_separable"], counts["primitive_directly_separable_in_another_orientation"],
            counts["primitive_in_all_orientations"]) == (367, 116, 236)
    assert len(gap4_primitive) == 41
    endpoints = {(n, end) for n, h, k in gap4_primitive for end in (h, k)}
    for move in supplied:
        n, old, new = move["n"], tuple(move["old"]), tuple(move["new"])
        assert valid_hooks(old, n, 2) and valid_hooks(new, n, 2)
        exact = Fraction(dim(new), dim(old))
        assert exact > 1 and exact == Fraction(move["exact_ratio"])
        matched = (n, old) in endpoints
        assert matched == move["matches_primitive_gap4_endpoint"]
        if matched:
            counts["supplied_moves_matching_gap4_primitive_endpoint"] += 1
            covered.add((n, old))
    counts["gap4_primitive_pairs_covered_by_supplied_moves"] = sum(
        (n, h) in covered or (n, k) in covered for n, h, k in gap4_primitive)
    counts["supplied_moves"] = len(supplied)
    assert (counts["supplied_moves"], counts["supplied_moves_matching_gap4_primitive_endpoint"],
            counts["gap4_primitive_pairs_covered_by_supplied_moves"]) == (28, 26, 26)
    return {"n_range":[min(row["n"] for row in pairs), max(row["n"] for row in pairs)], **counts}


def check_move(n, h, moved, expected=None, gap=2):
    assert valid_hooks(h, n, gap) and valid_hooks(moved, n, gap), (n, h, moved)
    ratio = Fraction(dim(moved), dim(h))
    if expected is not None:
        assert ratio == Fraction(expected), (h, moved, ratio, expected)
    return str(ratio)


def check_gap_fixtures():
    fixtures = read(HERE / "inputs/gap_comparisons.json")
    results = []
    for group in fixtures:
        h, n = group["h"], group["n"]
        for move in group["moves"]:
            ratio = check_move(n, h, move["h_prime"], move.get("ratio"))
            results.append({"id":group["id"], "n":n, "h":h, **move, "ratio":ratio})
    return results


def first_unit_improvement(h, gap):
    original = dim(h)
    for source, old in enumerate(h):
        if old <= 1:
            continue
        for target in range(len(h)):
            if source == target:
                continue
            new = list(h)
            new[source] -= 1
            new[target] += 1
            if valid_hooks(new, sum(h), gap) and dim(new) > original:
                return {
                    "n":sum(h), "old_h":h, "move_from":source + 1, "move_to":target + 1,
                    "h":new, "ratio":str(Fraction(dim(new), original)),
                }
    return None


def wrong_size_g2(n, r):
    """Reproduce the large-slack indexing error in scripts/g2_extend_certificate.py."""
    extra = slack(n, r, 4)
    assert extra > 40
    best, best_weight = None, Fraction(0)
    g = [0] * r

    def visit(index, left, cap, terminal):
        nonlocal best, best_weight
        if index == r:
            if left == 0:
                # The source recurses over g[-1], but reconstructs with terminal.
                h = [1 + terminal]
                for step in reversed(g[:-1]):
                    h.insert(0, h[0] + 4 + step)
                w = Fraction(dim(h), factorial(sum(h)))
                if w > best_weight:
                    best, best_weight = h, w
            return
        for value in range(min(cap, left // (index + 1)) + 1):
            g[index] = value
            visit(index + 1, left - (index + 1) * value, value, terminal)

    for terminal in range(min(extra // r + 1, 20)):
        remaining = extra - r * terminal
        visit(0, remaining, remaining, terminal)
    return best, best_weight


def check_candidate_counterexamples(natural, profiles):
    fixture = read(HERE / "inputs/candidate_counterexamples.json")
    expected = fixture["candidate_regressions"]
    g2 = expected["g2"]
    old, w = wrong_size_g2(g2["n"], g2["rank"])
    assert old == g2["original_returned_h"] and w == Fraction(g2["original_W_for_wrong_size"])
    assert sum(old) == g2["original_returned_sum"] != g2["n"]
    full = {h:dim(h) for h in hook_sequences(g2["n"], g2["rank"], 4)}
    restricted = {h:d for h, d in full.items() if h[-1] <= 20 and
                  all(x >= y for x, y in zip(gaps(h), gaps(h)[1:]))}
    assert (len(full), len(restricted)) == (g2["unrestricted_count"], g2["restricted_count"])
    winner, restricted_winner = max(full, key=full.get), max(restricted, key=restricted.get)
    assert list(winner) == g2["certified_h"] and full[winner] == int(g2["certified_degree"])
    assert list(restricted_winner) == g2["best_in_intended_restricted_domain"]
    assert sum(d == full[winner] for d in full.values()) == 1
    assert Fraction(full[winner], restricted[restricted_winner]) == Fraction(g2["certified_over_restricted"]) > 1

    layer = expected["layer"]
    h = layer["h"]
    r = len(h)
    old_shape_sum = sum(i + 1 + x // 2 for i, x in enumerate(h)) + r * sum((x - 1) // 2 for x in h)
    assert sum(balanced(tuple(h))) == layer["n"] and old_shape_sum == layer["source_h_to_lambda_sum"] != layer["n"]
    x, step = layer["ratio_x"], layer["ratio_step"]
    y = [a + b for a, b in zip(x, step)]
    incorrect = Fraction(y[0] - y[1], x[0] - x[1]) * prod(Fraction(factorial(b), factorial(a)) for a, b in zip(x, y))
    p, q = (tuple(z for z in (t[0] - 1, t[1]) if z) for t in (x, y))
    correct = Fraction(degree(q), degree(p))
    assert incorrect == Fraction(layer["source_ratio"]) != correct == Fraction(layer["correct_ratio"])
    assert fixture["corrected_201_fields"] == layer["corrected_201_fields"]

    for name, flagged in fixture["local_flags"].items():
        for gap in (2, 3):
            failures = [m for h in flagged if (m := first_unit_improvement(h, gap))]
            assert failures == expected["unit_transfer_flags"][name][f"gap{gap}_counterexamples_to_true_local_flag"]

    beaten_old_candidates = []
    for row in fixture["older_maxima"]:
        n = row["n"]
        new_h = natural[str(n)]["maximizing_h"][0]
        exact = check_move(n, row["h"], new_h, row["certified_over_old"])
        assert Fraction(exact) > 1
        beaten_old_candidates.append({**row, "certified_h":new_h})

    cross_rank = []
    for n, r, target in ((28, 4, "32175/32768"), (69, 6, "3276/3553"), (71, 6, "484701875/603979776")):
        rows = profiles[str(n)]["ranks"]
        h = rows[r - 1]["maximizing_h"][0]
        lower = rows[r - 2]["maximizing_h"][0]
        assert h[-1] == 1 and dim(lower) > dim(h)
        receiver_ratios = {}
        for receiver in range(r - 1):
            moved = h[:-1]
            moved[receiver] += 1
            if valid_hooks(moved, n, 4):
                exact = check_move(n, h, moved)
                assert Fraction(exact) < 1
                receiver_ratios[str(receiver + 1)] = exact
        assert receiver_ratios["1"] == target
        cross_rank.append({"n":n, "r":r, "h":h, "next_lower_rank_h":lower,
                           "next_lower_rank_ratio":str(Fraction(dim(lower), dim(h))),
                           "valid_single_receivers_in_gap4":receiver_ratios})

    n69 = check_move(69, [24, 17, 13, 9, 5, 1], [26, 17, 13, 9, 4], "24958395/27262976", 4)
    n47 = profiles["47"]
    split_obstruction = n47["ranks"][3]["maximizing_h"][0]
    assert n47["peak_ranks"] == [5] and max(gaps(split_obstruction)) < 8 and split_obstruction[-1] < 5
    assert profiles["18"]["ranks"][1]["maximizing_h"][0][0] == profiles["18"]["ranks"][2]["maximizing_h"][0][0]
    # In the source's split-receiver formula the deleted interaction is
    # evaluated at the moved hook. For n=71 this introduces a factor 168/169.
    correct_drop = Fraction(cross_rank[-1]["valid_single_receivers_in_gap4"]["1"])
    spurious_factor = Fraction(24 * 24, 26 * 26) / Fraction(25 * 25 - 1, 27 * 27 - 1)
    assert spurious_factor == Fraction(168, 169)
    return {
        "g2":g2,
        "layer":layer,
        "false_local_flags":expected["unit_transfer_flags"],
        "beaten_old_candidates":beaten_old_candidates,
        "cross_rank_obstructions":cross_rank,
        "n69_compound_move_ratio":n69,
        "n47_split_obstruction":split_obstruction,
        "n71_split_receiver_erroneous_over_correct_factor":str(spurious_factor),
        "n71_split_receiver_erroneous_ratio":str(correct_drop * spurious_factor),
    }


def main():
    if not __debug__:
        raise RuntimeError("Run without -O so the verification assertions are enabled")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result-dir", type=Path, default=HERE.parent / "evidence/compute")
    parser.add_argument("--node", default="node")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    counts = partition_counts(350)
    natural, profiles, tables = check_tables(args.result_dir, counts)
    report = {
        "scope":"Independent ordinary-hook endpoints, domain counts and exact fixtures",
        "tables":tables,
        "samples":check_samples(args.node, counts, natural, profiles),
        "listed_collisions":check_collisions(natural),
        "hook_move_fixtures":check_gap_fixtures(),
        "source_regressions":check_candidate_counterexamples(natural, profiles),
    }
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(encoded, encoding="utf-8", newline="\n")
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
