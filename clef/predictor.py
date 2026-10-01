"""Hopsworks predictor: Cloudflare Clef-Flash answering Jev/SystemOne requests.

Each request row is a SystemOne request body (state, questions), as the jev pilot sends it to
TypeSafe; the answer is the SystemOne response body Clef's own `systemone` builds (answers keyed
by question id), plus forward_seconds and the registry model. The model files are the release
Cloudflare publishes (Cloudflare/clef-flash): backbone, joint schema head, and the
`joint_schema_model` module that loads and runs them.
"""

import os
import sys
import time


class Predictor:
    def __init__(self, model):
        path = os.environ["MODEL_FILES_PATH"]
        sys.path.insert(0, path)
        from joint_schema_model import load_release_model, systemone

        self.systemone = systemone
        self.model, self.processor = load_release_model(path, device="cuda")
        self.revision = f"hopsworks:{model.name}/{model.version}"

    def predict(self, inputs):
        if not isinstance(inputs, list):
            raise ValueError("Request body must carry a list of SystemOne requests under 'inputs' or 'instances'")
        answers = []
        for request in inputs:
            started = time.perf_counter()
            response = self.systemone(self.model, self.processor, request)
            answers.append({**response, "forward_seconds": time.perf_counter() - started, "model": self.revision})
        return answers
