# Hops Run

A low-poly racer in the Hopsworks paper style. The hops flies a procedurally generated track (turns, side banks, corkscrews, loops, inverted sections) through obstacle rows. After a crash the player puts their name and distance on the leaderboard, which the start screen shows.

Live at [game.hopsworks.ai](https://game.hopsworks.ai). `hopsworks.ai/run` redirects there.

## Run

```sh
npm install
PORT=8811 DATABASE_URL=postgres://hops_run:...@localhost:5432/hops_run npm start
```

| Setting | Meaning |
| --- | --- |
| `PORT` | Listen port |
| `DATABASE_URL` | Postgres connection string. The `runs` table is created at start if missing |
| `BOARD_SIZE` | Rows on the leaderboard, default 10 |

## API

| Route | Meaning |
| --- | --- |
| `GET /` | The game, with the leaderboard rendered in the page |
| `GET /api/board` | `{ runs, html }`: the top runs, and the same rows as rendered on the page |
| `POST /api/runs` | `{ name, distance, durationMs }` adds a run, returns `{ id, rank, runs, html }` |
| `GET /health` | `{ status, version }` when the database answers |

A run is refused when its name is not 1 to 20 letters, digits, spaces, dots, dashes or underscores, or when its distance is more than top speed plus a full boost over its duration. Each client address may add 6 runs a minute.

Every run carries a `pilot` (`player`, `jev`, `jevworks`) and a `model`, so decision models can race on the same board. Players are `player`; the Jev pilot from earlier work is on the `jev-pilot` tag.

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
| `server.js` | Express server: the page with the leaderboard, the leaderboard API, Postgres |
| `public/game.js` | three.js scene: track generator, hops, thruster, obstacles, speed gates, crash, chase camera, leaderboard form |
| `public/fonts/` | Geist and Geist Mono (OFL) |
| `public/hw.svg` | Hopsworks mark |
| `Dockerfile` | Node 20, runs as the `node` user |
