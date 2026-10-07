# Designer

A new edition of Hops Run every day, published to the game as its live edition.

Each day (00:05 UTC, and at start when the day has none):

1. Draws candidate editions from the day's seed, within the game's bounds: walls always, the other kinds by chance and weight, a share of two-lane rows, zones and rules by chance, a gap range. Each is described in plain words.
2. Flies every bot in [`bots/`](../bots) on each candidate in the [arena](../arena/README.md), over the day's seeds, and keeps those whose bots' median falls in the band (default 600 to 4,000 m); with none in it, the three nearest.
3. Asks SemIf on Qwen (the `qwen` pilot's deployment) which one the game plays today, told what each holds, the bots' median on it, and how yesterday's edition went.
4. Publishes the pick (`POST /api/editions`, slug the date, designer `qwen · <model>`), live at once, and posts the bots' runs on it to the bots' board.

## Run

```sh
(cd game && npm ci)
GAME_URL=http://localhost:8811/ SEMIF_URL=... PILOT_TOKEN=... HOPSWORKS_API_KEY=... APP_PORT=8899 node designer/designer.js
```

| Setting | Meaning |
| --- | --- |
| `GAME_URL` | The game editions are published to |
| `SEMIF_URL` | Path-routed predict URL of the semif deployment |
| `PILOT_TOKEN` | Bearer token the game takes editions and bots' runs with |
| `CANDIDATES` | Candidate editions drawn a day, default 8 |
| `SEEDS` | Seeds each bot flies a candidate on, default 10 |
| `BAND` | The bots' median a candidate must fall in, metres, default `600-4000` |
| `APP_PORT` | Health port |
| `HOPSWORKS_API_KEY` | Outside Hopsworks; inside an App the pod's JWT authenticates to semif |

`GET /health` answers what it did last, when it runs next, the bots it flies and the band.

## Deploy

As a Hopsworks App on CPU, next to the pilots and never on their GPU:

```sh
HOPSWORKS_HOST=10.117.191.130 HOPSWORKS_PROJECT=jevworks HOPSWORKS_API_KEY=... python designer/deploy.py
```

`--semif`, `--candidates`, `--seeds`, `--band`, `--game-url` and `--token-secret` (default `jevworks_pilot_token`, the pilots' token) set the rest. The sources go up in the repo's layout, and `start.sh` installs three.js next to them on local disk.

## Files

| Path | Role |
| --- | --- |
| `designer.js` | The daily cycle: candidates, the arena's gate, SemIf's pick, publishing |
| `start.sh` | App entrypoint: copies the sources to local disk, reads the token, runs the designer |
| `deploy.py` | Uploads the sources and (re)creates the App |
