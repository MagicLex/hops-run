"""Score Jev's moves against every one-row situation, through the game server's /api/decide.

A situation is the hops' lane plus the nearest row (one or two lanes taken, each by a wall, a low
block or a bar), with a random second row behind it. A move is correct when it gets the hops past
the nearest row in one action: a lane change into an open lane, a jump over a low block or a bar,
a duck under a bar, or holding in an open lane. Where no single move passes, a lane change towards
an open lane counts.

    python eval/decide.py [--url http://localhost:8811/api/decide] [--seed 7] [--show-failures]
"""

import argparse
import itertools
import json
import random
import urllib.request

LANES = ["left", "centre", "right"]
KINDS = ["wall", "low", "bar"]


def situations(rnd):
    for lane in LANES:
        for n in (1, 2):
            for taken in itertools.combinations(LANES, n):
                for kinds in itertools.product(KINDS, repeat=n):
                    near = dict(zip(taken, kinds))
                    behind = dict(zip(rnd.sample(LANES, rnd.choice((1, 2))), rnd.choices(KINDS, k=2)))
                    yield lane, near, behind


def correct(lane, near):
    i = LANES.index(lane)
    here = near.get(lane)
    good = set()
    if here is None:
        good.add("hold")
    if here in ("low", "bar"):
        good.add("up")
    if here == "bar":
        good.add("down")
    for move, j in (("left", i - 1), ("right", i + 1)):
        if 0 <= j < 3 and LANES[j] not in near:
            good.add(move)
    if not good:  # two lanes away: head towards the open lane
        target = next(j for j, l in enumerate(LANES) if l not in near)
        good.add("left" if target < i else "right")
    return good


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="http://localhost:8811/api/decide")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--show-failures", action="store_true")
    args = parser.parse_args()

    rnd = random.Random(args.seed)
    total = ok = 0
    by_kind, fails, ms = {}, [], []
    for lane, near, behind in situations(rnd):
        body = {"lane": lane, "airborne": False, "ahead": [{"distance": 40, "lanes": near}, {"distance": 95, "lanes": behind}]}
        req = urllib.request.Request(args.url, json.dumps(body).encode(), {"Content-Type": "application/json"})
        d = json.load(urllib.request.urlopen(req))
        pick = d["moves"][d["probabilities"].index(max(d["probabilities"]))]
        good = correct(lane, near)
        hit = pick in good
        total += 1
        ok += hit
        ms.append(d["roundTripMs"])
        key = near.get(lane, "open")
        by_kind.setdefault(key, [0, 0])
        by_kind[key][0] += hit
        by_kind[key][1] += 1
        if not hit:
            fails.append((lane, near, pick, sorted(good)))
    print(f"{ok}/{total} correct ({100 * ok / total:.1f}%), median round trip {sorted(ms)[len(ms) // 2]:.0f} ms")
    for key, (a, n) in sorted(by_kind.items()):
        print(f"  own lane {key:5s} {a}/{n}")
    if args.show_failures:
        for f in fails:
            print("  FAIL", f)


if __name__ == "__main__":
    main()
