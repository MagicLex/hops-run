"""Hopsworks predictor: SemIf direct logit readout for runtime-defined decisions.

Request rows follow the SemIf row contract:

    {"id": "...", "state": <str|object|array>, "question": "...",
     "options": [{"id": "...", "description": "..."}, ...]}

Each row is answered with the option probabilities read from one forward pass.
"""

import os

import torch

from jevworks.semif.core import load_causal_model, resolve_device
from jevworks.semif.direct import score


class Predictor:
    def __init__(self, model):
        source = os.environ["MODEL_FILES_PATH"]
        device = os.environ.get("SEMIF_DEVICE", "auto")
        target = resolve_device(device)
        dtype = os.environ.get("SEMIF_DTYPE") or ("float32" if target.type == "cpu" else "bfloat16")
        threads = os.environ.get("SEMIF_THREADS")
        if threads:
            torch.set_num_threads(int(threads))
        self.model, self.tokenizer, self.metadata = load_causal_model(
            source,
            revision=f"hopsworks:{model.name}/{model.version}",
            device=device,
            dtype=dtype,
        )

    def predict(self, inputs):
        if not isinstance(inputs, list):
            raise ValueError("Request body must carry a list of decision rows under 'inputs' or 'instances'")
        return [score(self.model, self.tokenizer, row, self.metadata) for row in inputs]
