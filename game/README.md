# Game

Hops Run is a low-poly racer in the Hopsworks paper style. The hops flies a procedurally generated track (turns, side banks, corkscrews, loops, inverted sections) through obstacle rows. A run is flown on classic or on the day's live edition; after a crash the player puts their name and distance on that edition's board. The start screen shows the boards (players and model pilots, bots, editions) as a carousel of paper slabs over the track.

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
| `GET /?edition=` | The game, with its boards rendered in the page, on `classic` (default), `live` (the latest edition published) or an edition's slug |
| `GET /api/board?edition=` | `{ edition, runs, html, boards }`: the players' board on that edition, and the three boards (`players`, `bots`, `editions`) as rendered on the page |
| `POST /api/editions` | With `Authorization: Bearer <pilot token>`, `{ slug, designer, spec }` publishes an edition, live at once. The spec is checked with `public/sim.js` (`checkEdition`); 409 when the slug exists |
| `POST /api/runs/start` | `{ runKey }`: the key of the run taking off. The server records the takeoff time |
| `POST /api/runs` | `{ name, distance, durationMs, runKey }` adds a player's run, returns `{ id, rank, runs, html }`. A second post with the same key records nothing and returns the run already recorded, so the page retries safely through a restart. With `Authorization: Bearer <pilot token>` and `{ pilot, model }` it adds a model pilot's run, or a bot's (`pilot: bot`, from the arena), and returns `{ number, best, runs, html, boards }`. `edition` is the slug the run was flown on, `classic` by default |
| `POST /api/seat` | `{}` joins, `{ id, active }` is the heartbeat. Returns `{ id, state, position, heartbeatMs }`, `state` one of `play`, `wait`, `gone` |
| `POST /api/seat/leave` | `{ id }` frees the seat or the place in line |
| `GET /health` | `{ status, version, edition, players, waiting, maxPlayers }` when the database answers; `edition` is the live one |

A player's run is timed by the server: it needs a key from `POST /api/runs/start`, may last no longer than the time since that takeoff, and may cover no more than the hops can fly in its duration (the speed curve plus a boost gate at most every 140 m, with a 5% margin; the constants are the game's own, from `public/sim.js`). A run is also refused when its name is not 1 to 20 letters, digits, spaces, dots, dashes or underscores. Each client address may take off 30 times and add 6 runs a minute.

At most `MAX_PLAYERS` pages play at once; the others wait in arrival order and the start screen shows their place in line. A page holds its seat with a heartbeat every 10 s and loses it after 30 s of silence. A seated player idle for 2 minutes gives up the seat when someone is waiting. Seats and queue live in the server process: a restart empties them and pages join again on their next heartbeat. Each client address may hold 8 seats or places in line.

Analytics: Umami (`analytics.hops.io`, website `Hops Run`) records page views and the events `run-start`, `crash` (`distance`), `board-submit` (`distance`, `rank`) and `queue-wait` (`position`).

Every run carries its edition, a `pilot` (`player`, `jev`, `qwen`, `kumo`, `clef`, or `bot`) and a `model`. Each edition has three boards: players and model pilots, so decision models race players on the same board; bots, whose runs come from the [arena](../arena/README.md); and the editions, newest first, with their designer, runs and best. Players are `player`, marked with a person; a model pilot's first row also shows how many runs it has flown. A model pilot posts every run it flies, numbered, and each run ranks on the board like a player's, marked with a robot and credited to its maker (jev: TypeSafe, qwen: SemIf, kumo: NVIDIA, clef: Cloudflare). The best player and each model pilot missing from the top runs are listed below them, each with its best run and that run's place. The Jev pilot from earlier work is on the `jev-pilot` tag.

## Simulation

`public/sim.js` is the game without its pictures: the track, the rows and speed gates on it, the hops' flight and collisions. The page draws a run from it, the server reads its constants, and the [arena](../arena) flies pilots on it headless.

- Time advances in fixed steps of 1/120 s; the page draws between the last two. A run draws its track, rows and gates from three streams seeded from its seed, so a seed and the same moves at the same steps replay the same run, at any frame rate.
- No row is impossible. Before a row is placed, a witness flies through it: hopses searched through the same physics, with the moves a model pilot has (a lane change at any time, a jump or duck armed against the next row), each one already past every earlier row. A row no witness passes is drawn again, and moved 10 m further after 12 failed draws. Rows are placed up to 600 m ahead within 4 ms per frame, so the search never stalls a frame.
- Obstacles and zones are data (`KINDS`, `ZONES`): boxes, each standing in its lane or moving along a path keyed on the hops' distance to its row, and stretches of track where gravity or grip is scaled or left and right swap. Each has a description pilots are told. The game's kinds are `wall`, `low`, `bar`, `sweeper` and `dropbar`; its zones `drift`, `float` and `mirror`.
- Rules are checked as the hops clears a row (`RULES`: `bounce`, `hold`, `air`, `duck`); a broken rule counts as a crash.
- An edition is the track's content as data: which kinds, zones and rules come and how often. `CLASSIC` (walls, low blocks and bars) is the game's own. The simulation checks an edition against its bounds and every row against the witness, whoever made it. The [arena](../arena/README.md) documents editions, makers, kinds, zones, rules and their bounds.

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
| `T` | Classic or the live edition, on the start and crash screens |
| `B` | Slides the leaderboards' carousel to the next board |
| `←` `→` or `A` `D` | Change lane: dodges a wall |
| `↑` or `W` | Jump: clears a low block or a bar, spends the jump charge |
| `↓` or `S` | Duck: squeezes under a bar |

## Layout

| Path | Role |
| --- | --- |
| `server.js` | Express server: the page with its boards and editions, the boards and editions API, seats, Postgres |
| `public/sim.js` | The simulation: track generator, rows and the witness, speed gates, the hops' physics and collisions |
| `public/game.js` | three.js scene drawing a run: track, hops, thruster, obstacles, zones, speed gates, crash, chase camera, the leaderboards' carousel, leaderboard form |
| `public/fonts/` | Geist and Geist Mono (OFL) |
| `public/hw.svg` | Hopsworks mark |
| `public/og.jpg` | Share card image, 1200x630, a capture of the game |
| `Dockerfile` | Node 20, runs as the `node` user |
