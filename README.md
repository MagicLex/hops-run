# Hops Run

A low-poly racer in the Hopsworks paper style. The hops flies a procedurally generated track (turns, side banks, corkscrews, loops) through obstacle rows. The pilot is the player or Jev: the `semif` deployment from [jevworks](https://github.com/MagicLex/jevworks) reads the lanes ahead as text and picks the move from one forward pass.

## Run

```sh
npm install
PORT=8811 \
SEMIF_URL=http://<istio-ingress>/v1/<project>/<deployment>/v1/models/<deployment>:predict \
HOPSWORKS_API_KEY=... \
npm start
```

| Setting | Meaning |
| --- | --- |
| `PORT` or `APP_PORT` | Listen port |
| `SEMIF_URL` | Path-routed predict URL of the semif deployment |
| `HOPSWORKS_API_KEY` | API key with the `SERVING` scope. Inside a Hopsworks App the pod's own JWT is used instead |

The same keys can live in a `config.json` next to `server.js` (`port`, `semifUrl`, `apiKey`), which is how a Hopsworks App receives them. Environment variables win.

## Deploy as a Hopsworks App

```sh
HOPSWORKS_HOST=... HOPSWORKS_API_KEY=... HOPSWORKS_PROJECT=jevworks \
python deploy/app.py --deployment semif8b
```

Uploads the sources to `Resources/hops_run`, writes `config.json` with the in-cluster predict URL, creates the app (`CUSTOM`, `bash start.sh`, port 8080), switches it to root proxy routing and starts it.

## Controls

| Key | Move |
| --- | --- |
| `J` | Jev flies |
| `Space` | You fly |
| `←` `→` or `A` `D` | Change lane: dodges a wall |
| `↑` or `W` | Jump: clears a low block, spends the jump charge |
| `↓` or `S` | Duck: passes under a bar |

## Layout

| Path | Role |
| --- | --- |
| `server.js` | Express server: server-rendered page, `POST /api/decide` builds the prompt from the game state and calls semif |
| `deploy/app.py` | Deploys the game as a Hopsworks App |
| `eval/decide.py` | Scores Jev over every one-row situation through `/api/decide` |
| `public/game.js` | three.js scene: track generator, hops, thruster, obstacles, speed gates, crash, chase camera |
| `public/fonts/` | Geist and Geist Mono (OFL) |
| `public/hw.svg` | Hopsworks mark |
