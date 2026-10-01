# Hops Run

A low-poly racer in the Hopsworks paper style. The hops flies a procedurally generated track (turns, side banks, corkscrews, loops) through obstacle rows. The pilot is the player or Jev: the `semif` deployment from [jevworks](https://github.com/MagicLex/jevworks) reads the lanes ahead as text and picks the move from one forward pass.

## Run

```sh
npm install
PORT=8811 \
SEMIF_URL=http://<istio-ingress>/v1/models/semif:predict \
SEMIF_HOST=semif.<project>.hopsworks.ai \
HOPSWORKS_API_KEY=... \
npm start
```

| Setting | Meaning |
| --- | --- |
| `PORT` or `APP_PORT` | Listen port |
| `SEMIF_URL` | KServe predict URL of the semif deployment |
| `SEMIF_HOST` | Host header Istio routes the predictor on |
| `HOPSWORKS_API_KEY` | API key with the `SERVING` scope |

The same keys can live in a `config.json` next to `server.js` (`port`, `semifUrl`, `semifHost`, `apiKey`), which is how a Hopsworks App receives them. Environment variables win.

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
| `public/game.js` | three.js scene: track generator, hops, thruster, obstacles, speed gates, crash, chase camera |
| `public/fonts/` | Geist and Geist Mono (OFL) |
| `public/hw.svg` | Hopsworks mark |
