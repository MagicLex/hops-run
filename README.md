# jevworks

Decision models served as Hopsworks model deployments: [SemIf](https://github.com/TheoLeeCJ/SemIf) (formerly OpenJEV) semantic-if decisions on Qwen3, [NVIDIA Kumo Tabular](https://huggingface.co/nvidia/Kumo-Tabular) by in-context learning, and [Cloudflare Clef-Flash](https://huggingface.co/Cloudflare/clef-flash). Each deployment answers a decision with option ids, probabilities and its forward time.

They are the model pilots of [Hops Run](https://game.hopsworks.ai): a runner flies the live game in a headless browser, asks a deployment for every move, and posts each run to the game's leaderboard under that pilot. The pilots take turns, one run each, on one live stream.

| Deployment | Model | Hardware | Pilot | Code |
| --- | --- | --- | --- | --- |
| `semif4b` | Qwen3-4B, SemIf logit readout | 1 GPU, bfloat16 | `qwen` | `predictor.py`, `deploy.py` |
| `kumo` | Kumo Tabular small | 2 CPU cores | `kumo` | `kumo/` |
| `clef` | Clef-Flash | 1 GPU | `clef` | `clef/` |
| `semif`, `semif8b` | Qwen3-0.6B, Qwen3-8B | | | `predictor.py`, `deploy.py` |

## Layout

| Path | Role |
| --- | --- |
| `jevworks/semif/` | Engine vendored from SemIf (MIT). Only change: CPU device fallback. |
| `predictor.py` | SemIf Hopsworks Python predictor. Loads the registry model, scores rows. |
| `deploy.py` | Creates a SemIf deployment from the model registry. |
| `kumo/` | Kumo Tabular predictor, deploy script and requirements. |
| `clef/` | Clef-Flash predictor, deploy script and requirements. |
| `tests/test_decide.py` | Integration test against a running SemIf deployment. |
| `requirements.txt` | Installed into the SemIf inference environment. |

## SemIf

A decision is one forward pass. The model never generates text: the predictor builds a letter-choice prompt, reads the last-position logits at the answer-slot tokens, and softmaxes over those slots only.

### Setup

```bash
export HOPSWORKS_HOST=eu-west.cloud.hopsworks.ai
export HOPSWORKS_API_KEY=...
export HOPSWORKS_PROJECT=jevworks
```

Model, environment, deployment:

```bash
python -c 'import hopsworks; hopsworks.login().get_model_registry().hf_download("Qwen/Qwen3-0.6B", selected_formats=["safetensors"])'
hops env clone jevworks-inference --from torch-inference-pipeline
hops env install -f requirements.txt jevworks-inference
python deploy.py
```

`deploy.py` flips the imported model's framework from `LLM` to `TORCH` so the Python model server is used instead of vLLM, uploads `predictor.py`, and starts the deployment with the CPU resources given by `--cores` and `--memory`. Pass `--gpus 1` for a GPU instance. The Hops Run pilot runs on Qwen3-4B:

```bash
python -c 'import hopsworks; hopsworks.login().get_model_registry().hf_download("Qwen/Qwen3-4B", selected_formats=["safetensors"])'
python deploy.py --model Qwen3_4B --name semif4b --gpus 1 --memory 24576
```

### Request

```bash
hops deployment predict semif --data '{"inputs": [{
  "id": "ticket-1",
  "state": "Password reset succeeded but every login still returns account locked.",
  "question": "Which team should handle this ticket?",
  "options": [
    {"id": "billing", "description": "Billing and refunds"},
    {"id": "account-access", "description": "Authentication, lockouts and account recovery"}
  ]}]}'
```

Response, one entry per row:

```json
{"predictions": [{
  "id": "ticket-1",
  "option_ids": ["billing", "account-access"],
  "probabilities": [0.03, 0.97],
  "option_logits": [12.1, 15.6],
  "input_tokens": 118,
  "forward_seconds": 0.41,
  "total_seconds": 0.43,
  "prompt_sha256": "...",
  "prompt_version": "direct-options-v1",
  "model": {"source": "...", "revision": "hopsworks:Qwen3_0_6B/1", "dtype": "float32", "device": "cpu"},
  "readout": "native full-vocabulary last-position logits restricted to declared answer slots",
  "probability_status": "conditional option score; uncalibrated as decision confidence"
}]}
```

Rows need `id`, `state` (string, object or array), `question`, and 2 to 16 `options` with unique `id` and a `description`. A row whose prompt exceeds 4096 tokens is rejected, never truncated.

### Predictor environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEMIF_DEVICE` | `auto` | `cuda`, `mps`, `cpu`, or `auto` (first available in that order) |
| `SEMIF_DTYPE` | `float32` on CPU, `bfloat16` otherwise | Weight dtype |
| `SEMIF_THREADS` | torch default | Intra-op thread count on CPU |

### Test

```bash
pip install -e '.[deploy]'
pytest
```

## Kumo Tabular

Kumo Tabular decides a Hops Run move by in-context learning. Its context is a table of game situations (the lane, what each lane holds in the next row) labelled with the move the rules call for. A share of the situations is held out of the context, and the model's accuracy on them is logged at load. A request row is the game state itself:

```json
{"inputs": [{"lane": "centre", "airborne": false, "ahead": [{"distance": 30, "lanes": {"centre": "wall", "left": "bar"}}]}]}
```

The answer has the SemIf shape: `option_ids`, `probabilities` (moves the hops cannot make are masked out), `forward_seconds` and `model`. Only the small size is imported; `--size medium` or `large` needs its `classifier.pt` in the registry too.

```bash
python -c 'import hopsworks; hopsworks.login().get_model_registry().hf_download("nvidia/Kumo-Tabular", selected_filenames=["README.md", "LICENSE", "small/classifier.pt"])'
hops env clone kumo-inference --from torch-inference-pipeline
hops env install kumo-inference -f kumo/requirements.txt
python kumo/deploy.py   # --size small|medium|large, --holdout 0.3, --cores 2, --gpus 0
```

`KUMO_SIZE`, `KUMO_HOLDOUT`, `KUMO_SEED`, `KUMO_DEVICE` and `KUMO_THREADS` (set by `deploy.py` from its flags) configure the predictor.

## Clef-Flash

Clef-Flash answers a SystemOne request body (`state`, `questions`) with the SystemOne response Clef's own `systemone` builds, plus `forward_seconds` and the registry model. It runs Cloudflare's release files (backbone, joint schema head, `joint_schema_model`) on a GPU. The import is about 19 GB.

```bash
python -c 'import hopsworks; hopsworks.login().get_model_registry().hf_download("Cloudflare/clef-flash")'
hops env clone clef-inference --from torch-inference-pipeline
hops env install clef-inference -f clef/requirements.txt
python clef/deploy.py
```

Like `deploy.py`, `clef/deploy.py` flips the import's framework from `LLM` to `TORCH`.
