// Hops Run: a Hopsworks App (Express, server-rendered shell, three.js scene) where a hops flies
// down three lanes through random obstacle rows. The pilot is either the player or Jev: the
// semif deployment reads the lanes ahead as text and picks the move from one forward pass.
//
// Settings: config.json next to this file (per-app env vars never reach the pod, see
// hopsworks-animation issues A1), overridden by env for local runs:
//   PORT | APP_PORT        listen port
//   SEMIF_URL              KServe predict URL, e.g. http://<istio-ingress>/v1/models/semif:predict
//   SEMIF_HOST             Host header routing to the predictor, e.g. semif.jevworks.hopsworks.ai
//   HOPSWORKS_API_KEY      API key with the SERVING scope

import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';

const file = new URL('config.json', import.meta.url);
const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const cfg = {
  port: Number(process.env.PORT ?? process.env.APP_PORT ?? stored.port),
  semifUrl: process.env.SEMIF_URL ?? stored.semifUrl,
  semifHost: process.env.SEMIF_HOST ?? stored.semifHost,
  apiKey: process.env.HOPSWORKS_API_KEY ?? stored.apiKey,
};
for (const [key, value] of Object.entries(cfg)) {
  if (!value) throw new Error(`missing setting ${key}`);
}

const LANES = ['left', 'centre', 'right'];
const KINDS = { wall: 'a wall', low: 'a low block', bar: 'a bar overhead' };
const MOVES = {
  left: 'Move one lane to the left',
  right: 'Move one lane to the right',
  hold: 'Keep flying straight in the current lane',
  up: 'Jump, to fly over a low block or a bar',
  down: 'Duck, to fly under a bar',
};
const QUESTION = 'The hops flies forward through three lanes. A wall can only be avoided by changing lane, a low block by jumping over it, a bar by ducking under it or jumping over it. Which move gets the hops safely past the nearest row?';

// The game sends structured state; the prompt is built here so the browser never shapes it.
function row({ lane, airborne, ahead }) {
  if (!LANES.includes(lane)) throw new Error('lane must be left, centre or right');
  if (!Array.isArray(ahead)) throw new Error('ahead must be a list of rows');
  const rows = ahead.slice(0, 3).map(({ distance, lanes }) => {
    const parts = LANES.map((l) => `${l} lane ${KINDS[lanes?.[l]] ?? 'open'}`);
    return `In ${Math.round(distance)} m: ${parts.join(', ')}.`;
  });
  const i = LANES.indexOf(lane);
  const moves = Object.keys(MOVES).filter((m) => !(m === 'left' && i === 0) && !(m === 'right' && i === 2) && !(m === 'up' && airborne));
  return {
    id: 'hops',
    state: [`The hops is in the ${lane} lane${airborne ? ', in the air' : ''}.`, ...(rows.length ? rows : ['No obstacles ahead.'])].join(' '),
    question: QUESTION,
    options: moves.map((id) => ({ id, description: MOVES[id] })),
  };
}

// node:http, not fetch: fetch drops the Host header that Istio routes the predictor on.
// One keep-alive agent for the server's lifetime, so decisions reuse their connection.
const agent = new http.Agent({ keepAlive: true });
function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      agent,
      headers: { Host: cfg.semifHost, Authorization: `ApiKey ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('semif: timeout after 5 s')));
    req.on('error', reject);
    req.end(body);
  });
}

async function decide(state) {
  const input = row(state);
  const t0 = performance.now();
  const { status, text } = await post(cfg.semifUrl, JSON.stringify({ inputs: [input] }));
  if (status !== 200) throw new Error(`semif: HTTP ${status} ${text.slice(0, 300)}`);
  const [p] = JSON.parse(text).predictions;
  return {
    state: input.state,
    moves: p.option_ids,
    probabilities: p.probabilities,
    forwardMs: p.forward_seconds * 1000,
    roundTripMs: performance.now() - t0,
    device: p.model.device,
    dtype: p.model.dtype,
  };
}

const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hops Run</title>
<meta name="description" content="A hops flies through random obstacles, piloted by you or by Jev, a decision model served on Hopsworks.">
<link rel="preload" href="fonts/GeistMono.ttf" as="font" type="font/ttf" crossorigin>
<style>
@font-face { font-family: Geist; src: url(fonts/Geist.ttf); font-weight: 100 900; }
@font-face { font-family: 'Geist Mono'; src: url(fonts/GeistMono.ttf); font-weight: 100 900; }
:root { --bg: #F1EFEA; --fg: #151513; --dim: #8A867D; --green: #0E8F65; --error: #DC4F24; --rule: #D9D5CC; --m: clamp(16px, 3.2vw, 40px); }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--fg); font-family: Geist, system-ui, sans-serif; }
canvas { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
.grain { position: fixed; inset: -200px; pointer-events: none; opacity: 0.12; mix-blend-mode: multiply;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
.flash { position: fixed; inset: 0; pointer-events: none; background: var(--error); opacity: 0; mix-blend-mode: multiply; }
.hud { position: fixed; inset: 0; padding: var(--m); pointer-events: none; display: grid; grid-template-rows: auto 1fr auto; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.row.bottom { align-items: flex-end; }
.label { font-family: 'Geist Mono', monospace; font-size: 13px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); }
.label b { color: var(--fg); font-weight: 500; }
.mark { height: 32px; display: block; }
.metric { font-family: 'Geist Mono', monospace; font-size: clamp(36px, 6vw, 60px); letter-spacing: -0.04em; line-height: 1; text-transform: uppercase; }
.metric small { font-size: 0.4em; letter-spacing: 0.02em; color: var(--dim); margin-left: 6px; }
.stack { display: grid; gap: 10px; }
.right { text-align: right; justify-items: end; }
.mind { width: min(320px, 44vw); display: grid; gap: 8px; }
.move { display: grid; grid-template-columns: 56px 1fr 52px; align-items: center; gap: 10px; font-family: 'Geist Mono', monospace; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); }
.move .bar { height: 2px; background: var(--rule); position: relative; }
.move .bar i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--dim); }
.move .p { text-align: right; }
.move.pick { color: var(--fg); }
.move.pick .bar i { background: var(--fg); }
.move.off { opacity: 0.3; }
.jump { display: flex; align-items: center; gap: 10px; }
.gauge { width: 140px; height: 2px; background: var(--rule); position: relative; }
.gauge i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--fg); }
.gauge i.full { background: var(--green); }
#status.crash { color: var(--error); }
#status.flying { color: var(--fg); }
.center { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: none; }
.prompt { text-align: center; display: grid; gap: 16px; }
.prompt h1 { font-size: clamp(40px, 8vw, 92px); font-weight: 600; letter-spacing: -0.055em; margin: 0; line-height: 0.95; }
.prompt[hidden] { display: none; }
.keys { display: flex; gap: 24px; justify-content: center; }
.err { color: var(--error); }
@media (max-width: 640px) { .mind { width: 100%; } .row.bottom { flex-direction: column-reverse; align-items: stretch; } .right { text-align: left; justify-items: start; } }
</style>
<script type="importmap">{ "imports": { "three": "./vendor/three/three.module.js" } }</script>
</head>
<body>
<canvas id="scene"></canvas>
<div class="grain"></div>
<div class="flash"></div>
<div class="hud">
  <div class="row">
    <img class="mark" src="hw.svg" alt="Hopsworks">
    <div class="label">Hops Run <b>01</b></div>
  </div>
  <div></div>
  <div class="row bottom">
    <div class="stack">
      <div class="metric" id="distance">0<small>m</small></div>
      <div class="label">Speed <b id="speed">0</b> m/s · Pilot <b id="pilot">Jev</b></div>
      <div class="label jump">Jump <span class="gauge"><i id="charge"></i></span></div>
    </div>
    <div class="stack right">
      <div class="mind" id="mind">
        <div class="move" data-move="left"><span>Left</span><span class="bar"><i></i></span><span class="p">-</span></div>
        <div class="move" data-move="hold"><span>Hold</span><span class="bar"><i></i></span><span class="p">-</span></div>
        <div class="move" data-move="right"><span>Right</span><span class="bar"><i></i></span><span class="p">-</span></div>
        <div class="move" data-move="up"><span>Up</span><span class="bar"><i></i></span><span class="p">-</span></div>
        <div class="move" data-move="down"><span>Down</span><span class="bar"><i></i></span><span class="p">-</span></div>
      </div>
      <div class="label" id="model">Jev · semif · waiting</div>
      <div class="label" id="status">Ready</div>
    </div>
  </div>
</div>
<div class="center">
  <div class="prompt" id="prompt">
    <h1>Hops Run</h1>
    <div class="keys label"><span><b>J</b> Jev flies</span><span><b>Space</b> You fly</span></div>
    <div class="label">Steer ← → · Jump ↑ · Duck ↓</div>
  </div>
</div>
<script type="module" src="game.js"></script>
</body>
</html>`;

const app = express();
app.use(express.json({ limit: '16kb' }));
app.get('/', (_req, res) => res.type('html').send(page()));
app.get('/health', (_req, res) => res.send('ok'));
app.post('/api/decide', async (req, res) => {
  try {
    res.json(await decide(req.body));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.use('/vendor/three', express.static(fileURLToPath(new URL('node_modules/three/build/', import.meta.url)), { maxAge: '1d' }));
app.use(express.static(fileURLToPath(new URL('public/', import.meta.url))));
app.listen(cfg.port, '0.0.0.0', () => console.log(`hops-run on :${cfg.port}`));
