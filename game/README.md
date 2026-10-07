# Game

Hops Run is a low-poly racer in the Hopsworks paper style. The hops flies a procedurally generated track (turns, side banks, corkscrews, loops, inverted sections) through obstacle rows. After a crash the player puts their name and distance on the leaderboard, which the start screen shows.

Live at [game.hopsworks.ai](https://game.hopsworks.ai). `hopsworks.ai/run` redirects there.

## Run

From `game/`:

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
| `LIVE_YOUTUBE_CHANNEL` | YouTube channel id streaming the model pilots. The start and crash screens show a muted preview of its live stream, linked to YouTube, unloaded during a run |
| `LIVE_YOUTUBE_VIDEO` | YouTube video id of the pilots' broadcast. The preview plays it instead of the channel's current live, which YouTube picks among the channel's broadcasts when it runs more than one |
| `UMAMI_SRC`, `UMAMI_WEBSITE_ID` | Umami tracker script and website id. Analytics is off when either is unset |

## API

| Route | Meaning |
| --- | --- |
| `GET /` | The game, with the leaderboard rendered in the page |
| `GET /api/board` | `{ runs, html }`: the top runs, and the same rows as rendered on the page |
| `POST /api/runs/start` | `{ runKey }`: the key of the run taking off. The server records the takeoff time |
| `POST /api/runs` | `{ name, distance, durationMs, runKey }` adds a player's run, returns `{ id, rank, runs, html }`. A second post with the same key records nothing and returns the run already recorded, so the page retries safely through a restart. With `Authorization: Bearer <pilot token>` and `{ pilot, model }` it adds a model pilot's run and returns `{ number, best, runs, html }` |
| `POST /api/seat` | `{}` joins, `{ id, active }` is the heartbeat. Returns `{ id, state, position, heartbeatMs }`, `state` one of `play`, `wait`, `gone` |
| `POST /api/seat/leave` | `{ id }` frees the seat or the place in line |
| `GET /health` | `{ status, version, players, waiting, maxPlayers }` when the database answers |

A player's run is timed by the server: it needs a key from `POST /api/runs/start`, may last no longer than the time since that takeoff, and may cover no more than the hops can fly in its duration (the speed curve plus a boost gate at most every 140 m, with a 5% margin; constants mirrored from `public/game.js`). A run is also refused when its name is not 1 to 20 letters, digits, spaces, dots, dashes or underscores. Each client address may take off 30 times and add 6 runs a minute.

At most `MAX_PLAYERS` pages play at once; the others wait in arrival order and the start screen shows their place in line. A page holds its seat with a heartbeat every 10 s and loses it after 30 s of silence. A seated player idle for 2 minutes gives up the seat when someone is waiting. Seats and queue live in the server process: a restart empties them and pages join again on their next heartbeat. Each client address may hold 8 seats or places in line.

Analytics: Umami (`analytics.hops.io`, website `Hops Run`) records page views and the events `run-start`, `crash` (`distance`), `board-submit` (`distance`, `rank`) and `queue-wait` (`position`).

Every run carries a `pilot` (`player`, `jev`, `qwen`, `kumo`, `clef`) and a `model`, so decision models race on the same board. Players are `player`, marked with a person; a model pilot's first row also shows how many runs it has flown. A model pilot posts every run it flies, numbered, and each run ranks on the board like a player's, marked with a robot and credited to its maker (jev: TypeSafe, qwen: SemIf, kumo: NVIDIA, clef: Cloudflare). The best player and each model pilot missing from the top runs are listed below them, each with its best run and that run's place. The Jev pilot from earlier work is on the `jev-pilot` tag.

## Model pilots

The page enters pilot mode only when a runner exposes `hopsRunDecide` and `hopsRunFinished`; players never see it. The runner that flies the models around the clock is in [`pilot/`](../pilot).

## Deploy

On `crm-hops`, in the GTM stack (`/home/debian/stack`): services `hops-run` (built from `./hops-run`, synced from this folder) and `hops-run-db` (`postgres:16`, volume `hops-run-db-data`, password `HOPS_RUN_PG_PASSWORD` in `.env`). Caddy serves it publicly at `https://game.hopsworks.ai` (DNS: `game` A `57.129.92.116` on `hopsworks.ai`). `hopsworks.ai/run` is a redirect to it in the `hopsworks-web` site.

From the repo root:

```sh
tar --no-mac-metadata --exclude node_modules -C game -czf - . | ssh crm-hops 'rm -rf stack/hops-run && mkdir stack/hops-run && tar xzf - -C stack/hops-run'
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
| `public/game.js` | three.js scene: track generator, hops, thruster, obstacles, speed gates, crash, chase camera, leaderboard form |
| `public/fonts/` | Geist and Geist Mono (OFL) |
| `public/hw.svg` | Hopsworks mark |
| `public/og.jpg` | Share card image, 1200x630, a capture of the game |
| `Dockerfile` | Node 20, runs as the `node` user |
