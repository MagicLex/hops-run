"""Hopsworks predictor: NVIDIA Kumo Tabular deciding Hops Run moves by in-context learning.

The context is a table of game situations labelled with the move the rules call for: the hops'
lane and what each lane holds in the next row (a wall, a low block, a bar, or open). A share of
the situations is held out of the context, so the model must generalise to rows it has not seen;
its accuracy on them is logged at load. Each request row is a game state, as the pilot sends it:

    {"lane": "left" | "centre" | "right", "airborne": bool,
     "ahead": [{"distance": <m>, "lanes": {"left": "wall", ...}}, ...]}

and is answered like the semif predictor: option_ids, probabilities (moves the hops cannot make
are masked out), forward_seconds, model.

Settings (env): KUMO_SIZE (small, medium, large), KUMO_HOLDOUT (share of situations held out of
the context), KUMO_SEED (which situations), KUMO_DEVICE (cpu, cuda, auto), KUMO_THREADS (CPU
threads; the pod's cores, as PyTorch otherwise starts one per node core and oversubscribes).
"""

import itertools
import os
import random
import time

import pandas as pd
import torch

import sdm

LANES = ["left", "centre", "right"]
KINDS = ["wall", "low", "bar"]
MOVES = ["left", "hold", "right", "up", "down"]
CATEGORICAL = ["lane", "left_lane", "centre_lane", "right_lane", "move"]
SAMPLES_PER_SITUATION = 3  # distances drawn per situation in the context; the rules ignore distance


def rule_move(lane, near):
    """The move the rules call for: fly an open lane, jump a low block, duck a bar, else change
    lane towards the nearest open one."""
    i, here = LANES.index(lane), near.get(lane)
    if here is None:
        return "hold"
    if here == "low":
        return "up"
    if here == "bar":
        return "down"
    target = min((j for j, name in enumerate(LANES) if name not in near), key=lambda j: (abs(j - i), j))
    return "left" if target < i else "right"


def situations():
    """Every lane with an empty row ahead or a row of one or two obstacles (never three)."""
    for lane in LANES:
        yield lane, {}
        for n in (1, 2):
            for taken in itertools.combinations(LANES, n):
                for kinds in itertools.product(KINDS, repeat=n):
                    yield lane, dict(zip(taken, kinds))


def features(lane, near, distance):
    return {"lane": lane, **{f"{name}_lane": near.get(name, "open") for name in LANES}, "distance": float(distance)}


class Predictor:
    def __init__(self, model):
        size = os.environ.get("KUMO_SIZE", "small")
        holdout = float(os.environ.get("KUMO_HOLDOUT", "0.3"))
        seed = int(os.environ.get("KUMO_SEED", "7"))
        wanted = os.environ.get("KUMO_DEVICE", "auto")
        self.device = torch.device("cuda" if wanted == "auto" and torch.cuda.is_available() else ("cpu" if wanted == "auto" else wanted))
        self.revision = f"hopsworks:{model.name}/{model.version} {size}"
        if os.environ.get("KUMO_THREADS"):
            torch.set_num_threads(int(os.environ["KUMO_THREADS"]))

        # The registry holds the checkpoints NVIDIA publishes (nvidia/Kumo-Tabular v1.0.0); load the
        # classifier from there rather than from the Hub, as KumoTabular's own loader would.
        self.model = sdm.models.KumoTabular(task="classification", size=size, pretrained=False, device=self.device)
        path = os.path.join(os.environ["MODEL_FILES_PATH"], size, "classifier.pt")
        self.model.models[sdm.Task.classification].load_state_dict(torch.load(path, map_location=self.device, weights_only=True), assign=True)
        self.model.eval()

        rnd = random.Random(seed)
        all_situations = list(situations())
        rnd.shuffle(all_situations)
        cut = round(len(all_situations) * (1 - holdout))
        seen, held = all_situations[:cut], all_situations[cut:]
        context = pd.DataFrame([dict(features(l, n, rnd.uniform(5, 120)), move=rule_move(l, n)) for l, n in seen for _ in range(SAMPLES_PER_SITUATION)])
        self.stypes = sdm.infer_stypes(context, overrides={c: "categorical" for c in CATEGORICAL})
        table = sdm.TableTensor.from_pandas(df=context, stypes=self.stypes, device=self.device)
        self.model.fit(x=table.drop_columns("move"), y=table[:, "move"])

        if held:
            probe = pd.DataFrame([dict(features(l, n, 60.0), move=rule_move(l, n)) for l, n in held])
            picked = self._best(self._scores(probe.drop(columns="move")))
            right = sum(p == m for p, m in zip(picked, probe["move"]))
            print(f"Kumo Tabular {size} on {self.device}: {len(seen)} situations in context, {right}/{len(held)} held-out situations right", flush=True)

    def _scores(self, frame):
        frame = frame.assign(move=MOVES[0])  # the label column the stypes describe; ignored for queries
        out = self.model.predict(sdm.TableTensor.from_pandas(df=frame, stypes=self.stypes, device=self.device).drop_columns("move"))
        names = out.columns[sdm.Stype.numerical]
        return [dict(zip(names, row)) for row in out.numerical.float().cpu().tolist()]

    @staticmethod
    def _best(scores):
        return [max(s, key=s.get) for s in scores]

    def predict(self, inputs):
        if not isinstance(inputs, list):
            raise ValueError("Request body must carry a list of game states under 'inputs' or 'instances'")
        started = time.perf_counter()
        rows, options = [], []
        for state in inputs:
            lane, ahead = state["lane"], state.get("ahead") or []
            if lane not in LANES:
                raise ValueError("lane must be left, centre or right")
            nxt = ahead[0] if ahead else {"distance": 0.0, "lanes": {}}
            rows.append(features(lane, {k: v for k, v in (nxt.get("lanes") or {}).items() if v in KINDS}, nxt.get("distance", 0.0)))
            options.append([m for m in MOVES if not (m == "left" and lane == "left") and not (m == "right" and lane == "right") and not (m == "up" and state.get("airborne"))])
        scores = self._scores(pd.DataFrame(rows))
        seconds = time.perf_counter() - started
        answers = []
        for score, ids in zip(scores, options):
            total = sum(score.get(m, 0.0) for m in ids) or 1.0
            answers.append({
                "option_ids": ids,
                "probabilities": [score.get(m, 0.0) / total for m in ids],
                "forward_seconds": seconds,
                "model": {"revision": self.revision, "device": str(self.device)},
            })
        return answers
