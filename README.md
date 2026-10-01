# Hops Run

A low-poly racer in the Hopsworks paper style. The hops flies a procedurally generated track (turns, side banks, corkscrews, loops, inverted sections) through obstacle rows. After a crash the player puts their name and distance on the leaderboard, which the start screen shows.

Live at [game.hopsworks.ai](https://game.hopsworks.ai). `hopsworks.ai/run` redirects there.

## Run

```sh
npm install
PORT=8811 MAX_PLAYERS=200 DATABASE_URL=postgres://hops_run:...@localhost:5432/hops_run npm start
```

| Setting | Meaning |
| --- | --- |
| `PORT` | Listen port |
| `DATABASE_URL` | Postgres connection string. The `runs` table is created at start if missing |
| `MAX_PLAYERS` | Players flying at once. Beyond it, visitors wait in a live queue |
| `BOARD_SIZE` | Rows on the leaderboard, default 10 |
| `PILOT_TOKEN_SHA256` | sha256 (hex) of the bearer token model pilots post their runs with. Pilot runs are refused when unset |
| `PUBLIC_URL` | Public origin, e.g. `https://game.hopsworks.ai/`. Sets the canonical link and the share card (Open Graph, X) with `public/og.jpg`. No share card when unset |
| `LIVE_YOUTUBE_CHANNEL` | YouTube channel id streaming the jevworks pilot. The start and crash screens show a muted preview of its live stream, linked to YouTube, unloaded during a run |
| `UMAMI_SRC`, `UMAMI_WEBSITE_ID` | Umami tracker script and website id. Analytics is off when either is unset |

## API

| Route | Meaning |
| --- | --- |
| `GET /` | The game, with the leaderboard rendered in the page |
| `GET /api/board` | `{ runs, html }`: the top runs, and the same rows as rendered on the page |
| `POST /api/runs` | `{ name, distance, durationMs }` adds a run, returns `{ id, rank, runs, html }`. With `Authorization: Bearer <pilot token>` and `{ pilot, model }` it adds a model pilot's run and returns `{ number, best, runs, html }` |
| `POST /api/seat` | `{}` joins, `{ id, active }` is the heartbeat. Returns `{ id, state, position, heartbeatMs }`, `state` one of `play`, `wait`, `gone` |
| `POST /api/seat/leave` | `{ id }` frees the seat or the place in line |
| `GET /health` | `{ status, version, players, waiting, maxPlayers }` when the database answers |

A run is refused when its name is not 1 to 20 letters, digits, spaces, dots, dashes or underscores, or when its distance is more than top speed plus a full boost over its duration. Each client address may add 6 runs a minute.

At most `MAX_PLAYERS` pages play at once; the others wait in arrival order and the start screen shows their place in line. A page holds its seat with a heartbeat every 10 s and loses it after 30 s of silence. A seated player idle for 2 minutes gives up the seat when someone is waiting. Seats and queue live in the server process: a restart empties them and pages join again on their next heartbeat. Each client address may hold 8 seats or places in line.

Analytics: Umami (`analytics.hops.io`, website `Hops Run`) records page views and the events `run-start`, `crash` (`distance`), `board-submit` (`distance`, `rank`) and `queue-wait` (`position`).

Every run carries a `pilot` (`player`, `jev`, `jevworks`) and a `model`, so decision models race on the same board. Players are `player`. A model pilot posts every run it flies, numbered, and each run ranks on the board like a player's, marked with a robot. The Jev pilot from earlier work is on the `jev-pilot` tag.

## jevworks pilot

`pilot/` flies the live game for ever: a Hopsworks App on `lex-gpu` (project `jevworks`) runs the page in a headless Chromium rendering on a GPU, asks the `semif4b` deployment for every move, and posts each run to the board as `jevworks`. The page shows the decision (move probabilities, forward time, run number, best). When the game ships a new version the pilot reloads the page between runs.

The page enters pilot mode only when the runner exposes `jevworksDecide` and `jevworksFinished`; players never see it. The token lives in the Hopsworks secret `jevworks_pilot_token` of the deploying user; the game holds its sha256 in `PILOT_TOKEN_SHA256`.

```sh
HOPSWORKS_HOST=10.117.191.130 HOPSWORKS_PROJECT=jevworks HOPSWORKS_API_KEY=... python pilot/deploy.py   # --no-gpu: SwiftShader, 640x360
```

With the Hopsworks secret `jevworks_youtube_key` (a YouTube stream key), the App also streams the page live: Chromium's screencast into ffmpeg, NVENC h264 1080p30 at 6 Mbit/s with a silent audio track, over RTMPS to YouTube. `--no-stream` deploys without it.

`GET /health` on the App returns the pilot's runs, best, last distance, model, game version, WebGL renderer and stream state, and 503 when no decision came in 5 minutes. `GET /frame.jpg` returns what the page shows right now.

## Deploy

On `crm-hops`, in the GTM stack (`/home/debian/stack`): services `hops-run` (built from `./hops-run`, synced from this repo) and `hops-run-db` (`postgres:16`, volume `hops-run-db-data`, password `HOPS_RUN_PG_PASSWORD` in `.env`). Caddy serves it publicly at `https://game.hopsworks.ai` (DNS: `game` A `57.129.92.116` on `hopsworks.ai`). `hopsworks.ai/run` is a redirect to it in the `hopsworks-web` site.

```sh
tar --no-mac-metadata --exclude node_modules --exclude .git -czf - . | ssh crm-hops 'rm -rf stack/hops-run && mkdir stack/hops-run && tar xzf - -C stack/hops-run'
ssh crm-hops 'cd /home/debian/stack && docker compose up -d --build hops-run'
```

## Versions

The game version is `version` in `package.json`, tagged `v<version>` in git. It shows in the HUD and is stored with every run (`game_version`), so runs from before and after a change to the track or the physics stay distinguishable on the board. Bump it for any change that affects how far a run can go.

## Controls

| Key | Move |
| --- | --- |
| `Space` | Fly |
| `←` `→` or `A` `D` | Change lane: dodges a wall |
| `↑` or `W` | Jump: clears a low block or a bar, spends the jump charge |
| `↓` or `S` | Duck: squeezes under a bar |

## Layout

| Path | Role |
| --- | --- |
| `server.js` | Express server: the page with the leaderboard, the leaderboard API, seats, Postgres |
| `pilot/` | jevworks pilot: `runner.js` (Chromium + semif), `start.sh` (App entrypoint), `deploy.py` |
| `public/game.js` | three.js scene: track generator, hops, thruster, obstacles, speed gates, crash, chase camera, leaderboard form |
| `public/fonts/` | Geist and Geist Mono (OFL) |
| `public/hw.svg` | Hopsworks mark |
| `public/og.jpg` | Share card image, 1200x630, a capture of the game |
| `Dockerfile` | Node 20, runs as the `node` user |
