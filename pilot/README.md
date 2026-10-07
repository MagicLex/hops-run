# Pilot runner

The runner flies the live game for ever: a Hopsworks App on `lex-gpu` (project `jevworks`) runs the page in a headless Chromium rendering on a GPU. The decision models take turns, one run each: each asks its model for every move and posts its run to the board under its own pilot. The page shows who is flying and the decision (move probabilities, forward time, that pilot's run number and best). When the game ships a new version the runner reloads the page between runs.

`DECIDER` is the rotation, comma-separated (e.g. `semif,kumo,jev`; one decider flies alone): `semif` (pilot `qwen`: SemIf's logit readout on Qwen3, the default), `jev` (TypeSafe's Jev API, one Choice question per move; `JEV_URL`, `JEV_MODEL`, `TYPESAFE_API_KEY`), `kumo` (NVIDIA Kumo Tabular deciding by in-context learning over game situations labelled by the rules, deployed from [`kumo/`](../kumo); `KUMO_URL`) or `clef` (Cloudflare Clef-Flash answering the same SystemOne request as Jev, deployed from [`clef/`](../clef); `CLEF_URL`).

The page enters pilot mode only when the runner exposes `hopsRunDecide` and `hopsRunFinished`. The token lives in the Hopsworks secret `jevworks_pilot_token` of the deploying user; the game holds its sha256 in `PILOT_TOKEN_SHA256`.

```sh
HOPSWORKS_HOST=10.117.191.130 HOPSWORKS_PROJECT=jevworks HOPSWORKS_API_KEY=... python pilot/deploy.py   # --no-gpu: SwiftShader, 640x360
```

`--deciders` sets the rotation (default `semif,kumo`). Hopsworks deciders are deployments given as `[PROJECT/]NAME`, by default in the App's project: `--semif semif4b`, `--kumo kumo`, `--clef Kumo_Tabular/clef`; each is checked before the App is replaced. With `jev` in the rotation, the App reads its TypeSafe key from the secret `--typesafe-secret` (default `typesafe_api_key`).

With the Hopsworks secret `jevworks_youtube_key` (a YouTube stream key), the App also streams the page live: Chromium's screencast into ffmpeg, NVENC h264 1080p30 at 6 Mbit/s with a silent audio track, over RTMPS to YouTube. One ffmpeg runs for the life of the App: page reloads and browser relaunches never drop the ingest (the last frame is held between pages); only a redeploy of the App does. `--no-stream` deploys without it.

When `--stream-channel` (default: the channel the game previews) shows no live video for 90 seconds while the ingest runs, the runner reconnects the ingest, at most every 3 minutes: an ingest that connects while YouTube is still closing the previous broadcast stays bound to it and never goes live.

`GET /health` on the App returns the pilot flying now, each pilot's runs, best, last distance and model, the game version, WebGL renderer and stream state, and 503 when no decision came in 5 minutes. `GET /frame.jpg` returns what the page shows right now.

## Files

| Path | Role |
| --- | --- |
| `runner.js` | Chromium on the live page, the deciders in turn, the stream, `/health` and `/frame.jpg` |
| `deciders.js` | The deciders (`semif`, `kumo`, `jev`, `clef`): the request each model gets and its answer as move probabilities; shared with the [arena](../arena) |
| `start.sh` | App entrypoint: installs Chromium and its libraries on local disk, reads the secrets |
| `deploy.py` | Uploads the runner to the project and (re)creates the Hopsworks App |
