# jevworks

Decision models served as Hopsworks model deployments: [SemIf](https://github.com/TheoLeeCJ/SemIf) (formerly OpenJEV) semantic-if decisions on Qwen3, [NVIDIA Kumo Tabular](https://huggingface.co/nvidia/Kumo-Tabular) by in-context learning, and [Cloudflare Clef-Flash](https://huggingface.co/Cloudflare/clef-flash). Each deployment answers a decision with option ids, probabilities and its forward time.

They are the model pilots of [Hops Run](https://game.hopsworks.ai): a runner flies the live game in a headless browser, asks a deployment for every move, and posts each run to the game's leaderboard under that pilot. The pilots take turns, one run each, on one live stream.

| Deployment | Model | Hardware | Pilot | Code |
| --- | --- | --- | --- | --- |
| `semif4b` | Qwen3-4B, SemIf logit readout | 1 GPU, bfloat16 | `qwen` | `predictor.py`, `deploy.py` |
| `kumo` | Kumo Tabular small | 2 CPU cores | `kumo` | `kumo/` |
| `clef` | Clef-Flash (parked, not deployed) | 1 GPU | `clef` | `clef/` |
| `semif` | Qwen3-0.6B (stopped) | | | `predictor.py`, `deploy.py` |

## Hops Run

![A pilot in Hops Run, 1690 m into a run](docs/hops-run.jpg)

Play it at [game.hopsworks.ai](https://game.hopsworks.ai). The pilots fly it around the clock on the [live stream](https://www.youtube.com/channel/UCtuK0GKJl8TVLqj2702y_Fg/live), and every run they finish lands on the same leaderboard as yours.

## Game mechanics

Hops Run is procedural. The track and every row of obstacles are generated as you fly, so no two runs are the same and there is nothing to memorise. Straights, banked turns and hills come first; side banks unlock at 300 m, wall rides at 400 m, corkscrews at 500 m, upside-down sections at 700 m and loops at 900 m.

A row of obstacles fills one or two of the three lanes, never all three. Half the obstacles are walls (only a lane change gets you past), a quarter are low blocks (jump) and a quarter are bars (duck, or jump).

And it only gets harder. The hops starts at 45 m/s and gains 1.6 m/s every second up to 160 m/s; speed gates every 140 to 260 m add a 45 m/s burst on top. Rows start 42 to 74 m apart and close in until 2250 m, where they settle at 23 to 41 m.

So there is a ceiling, and it is physical. The fastest lane change the hops can make takes 0.15 s. From 5000 m, at 134 m/s, some rows arrive closer than that, and a wall in your lane right after a lane change cannot be passed by anyone - human or model. A perfect pilot (never wrong, zero decision time) has even odds of reaching 6300 m and less than a 1% chance of reaching 8750 m. That bound is generous: it counts one kind of impossible row only, and ignores the gates' extra speed and the time a jump keeps you in the air. The real ceiling is lower.

## How a pilot decides

The game hands the runner `{ lane, airborne, ahead }`, where `ahead` lists the rows in front of the hops with their distance and what each lane holds. Each model gets it in its own form.

**qwen** reads a description of the nearest row only:

- `state`: the rules, then the situation. *The hops crashes if it hits a wall: jumping or ducking never clears a wall, only moving to another lane does. Jumping clears a low block or a bar. Ducking clears a bar. Flying straight is only safe in an open lane. The hops is in the centre lane. The next row of obstacles is 60 m ahead.* "in the air" follows the lane when the hops is airborne; with no row ahead, the last sentence is "There are no obstacles ahead."
- `question`: "What should the hops do?"
- `options`, each stating the consequence of the move:
  - `left` / `right`: "Move to the left lane, which has a wall". Offered only where that lane exists.
  - `hold`: "Stay in the centre lane, which has nothing, it is open, and fly straight".
  - `up`: "Stay in the centre lane, which has ..., and jump". Offered only when the hops is on the ground.
  - `down`: "Stay in the centre lane, which has ..., and duck".

```
POST /v1/jevworks/semif4b/v1/models/semif4b:predict
{"inputs": [{"id": "hops", "state": "...", "question": "What should the hops do?",
             "options": [{"id": "left", "description": "..."}, ...]}]}

{"predictions": [{"id": "hops", "option_ids": ["left", "hold", "up", "down"],
                  "probabilities": [0.76, 0.01, 0.0, 0.0], "forward_seconds": 0.03,
                  "model": {"revision": "hopsworks:Qwen3_4B/1", "device": "cuda:0", "dtype": "bfloat16"}, ...}]}
```

**kumo** gets the game state as it is (`{"lane": "centre", "airborne": false, "ahead": [...]}`) and answers in the same shape. Its context is a table of 78 game situations labelled with the move the rules call for; the other 33 are held out, and it gets 31 to 33 of those right without ever seeing them.

The runner flies the highest-probability move. Jumps and ducks are timed to the row; lane changes apply at once.

## Results

Runs 100 to 500 of each pilot (401 each), on game v1.11.0, flown interleaved over the same night. The first 100 are left out.

| Pilot | Median | Mean | 90th percentile | Best | Runs to top 5 |
| --- | --- | --- | --- | --- | --- |
| kumo | 2,063 m | 2,095 m | 3,780 m | 5,994 m | 52 (24 min of flight) |
| qwen | 1,025 m | 1,284 m | 2,738 m | 4,840 m | not reached in 401 |

Top 5 means a run at or beyond the board's 5th place, 5,316 m. Both models answer in about 30 ms, so speed does not separate them; kumo picks the right move more often.

Neither model was trained on the game. qwen sees no examples at all; kumo sees 78 labelled ones in its context and is never trained on them.

## Behaviour and luck

Every run is a fresh, random track, and that makes for a lot of noise. Kumo flew 4,792 m on its 100th run and crashed at 473 m on the next one: same model, same weights, different track. A single run says very little; a median over a few hundred says something.

The leaderboard ranks best runs, and a best run is mostly a function of how many tries you get. I learned that the hard way: after kumo's first 18 runs I asked whether a bigger Kumo could keep up with Qwen. Qwen had over a thousand runs behind it at the time. Over the same 401 runs on the same game, kumo's median is twice qwen's, and it now holds four of the top five places. The best run on the board, 6,330 m, is still qwen's; that is luck doing its job, and also about where a perfect pilot's odds halve.

Neither model learns between runs.

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
