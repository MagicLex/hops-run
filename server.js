// Hops Run: Express server for the game. Serves the page with the leaderboard rendered in the
// initial HTML, the three.js scene, and the leaderboard API backed by Postgres. Every run on the
// board carries its pilot (a player, Jev, or jevworks) and the model behind it, so players and
// decision models race on one board.
//
// Settings (env):
//   PORT           listen port
//   DATABASE_URL   postgres://user:password@host:5432/db
//   BOARD_SIZE     rows on the leaderboard (default 10)
//   BASE_PATH      public path the game is served under, e.g. /run/ (default /): every asset and
//                  API URL in the page is relative to it, with or without a trailing slash

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';

const cfg = {
  port: Number(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL,
  boardSize: Number(process.env.BOARD_SIZE ?? 10),
  basePath: process.env.BASE_PATH ?? '/',
};
if (!cfg.port || !cfg.databaseUrl) throw new Error('missing setting: PORT and DATABASE_URL are required');
if (!/^\/([\w.-]+\/)*$/.test(cfg.basePath)) throw new Error('BASE_PATH must start and end with a slash, e.g. /run/');

// The pool lives for the process and is closed on shutdown.
const db = new pg.Pool({ connectionString: cfg.databaseUrl, max: 5 });
await db.query(`
  CREATE TABLE IF NOT EXISTS runs (
    id          bigserial PRIMARY KEY,
    name        text NOT NULL,
    pilot       text NOT NULL DEFAULT 'player' CHECK (pilot IN ('player', 'jev', 'jevworks')),
    model       text,
    distance_m  integer NOT NULL CHECK (distance_m >= 0),
    duration_ms integer NOT NULL CHECK (duration_ms > 0),
    client      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS runs_distance ON runs (distance_m DESC, created_at);
`);

// Game limits, mirrored from public/game.js: no run covers more than top speed plus a full boost
// for its whole duration. Anything beyond is refused.
const MAX_SPEED = 160 + 45; // m/s
const NAME = /^[\p{L}\p{N} ._-]{1,20}$/u;
const SUBMIT = { perMinute: 6 };

async function board() {
  const { rows } = await db.query(
    `SELECT name, pilot, model, distance_m, created_at FROM runs ORDER BY distance_m DESC, created_at ASC LIMIT $1`,
    [cfg.boardSize],
  );
  return rows;
}

// Per-client submission budget, in memory: a minute window per hashed client address.
const recent = new Map();
function allowed(client) {
  const now = Date.now(), hits = (recent.get(client) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= SUBMIT.perMinute) return false;
  recent.set(client, [...hits, now]);
  return true;
}
const clientOf = (req) => createHash('sha256').update(String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',')[0].trim()).digest('hex').slice(0, 16);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const boardRows = (rows) => rows.length
  ? rows.map((r, i) => `<li><span class="rank">${String(i + 1).padStart(2, '0')}</span><span class="who">${esc(r.name)}${r.pilot === 'player' ? '' : ` <i class="pilot">${esc(r.pilot)}${r.model ? ` · ${esc(r.model)}` : ''}</i>`}</span><span class="dist">${r.distance_m} m</span></li>`).join('')
  : '<li class="empty">No runs yet. Be the first.</li>';

const page = (rows) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${cfg.basePath}">
<title>Hops Run</title>
<meta name="description" content="Fly the hops through a procedural track of turns, loops and corkscrews. Dodge, jump and duck, then put your name on the leaderboard.">
<link rel="preload" href="fonts/GeistMono.ttf" as="font" type="font/ttf" crossorigin>
<style>
@font-face { font-family: Geist; src: url(fonts/Geist.ttf); font-weight: 100 900; }
@font-face { font-family: 'Geist Mono'; src: url(fonts/GeistMono.ttf); font-weight: 100 900; }
:root { --bg: #F1EFEA; --fg: #151513; --dim: #8A867D; --green: #0E8F65; --error: #DC4F24; --rule: #D9D5CC; --paper: #FCFBF8; --m: clamp(16px, 3.2vw, 40px); }
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
.jump { display: flex; align-items: center; gap: 10px; }
.gauge { width: 140px; height: 2px; background: var(--rule); position: relative; }
.gauge i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--fg); }
.gauge i.full { background: var(--green); }
#status.crash { color: var(--error); }
#status.flying { color: var(--fg); }
.center { position: fixed; inset: 0; display: grid; place-items: start center; pointer-events: none; padding: max(12vh, 88px) var(--m) var(--m); }
.prompt { text-align: center; display: grid; gap: 18px; justify-items: center; }
.prompt h1 { font-size: clamp(40px, 8vw, 92px); font-weight: 600; letter-spacing: -0.055em; margin: 0; line-height: 0.95; }
.prompt[hidden] { display: none; }
.keys { display: flex; gap: 24px; justify-content: center; flex-wrap: wrap; }
.board { width: min(420px, 100%); margin: 6px 0 0; padding: 0; list-style: none; font-family: 'Geist Mono', monospace; font-size: 14px; text-align: left; background: color-mix(in srgb, var(--paper) 80%, transparent); border: 1px solid var(--rule); }
.board li { display: grid; grid-template-columns: 34px 1fr auto; gap: 10px; padding: 7px 12px; border-top: 1px solid var(--rule); }
.board li:first-child { border-top: 0; }
.board li.you { background: color-mix(in srgb, var(--green) 12%, transparent); }
.board li.empty { display: block; color: var(--dim); text-align: center; }
.board .rank { color: var(--dim); }
.board .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board .pilot { color: var(--green); font-style: normal; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
.board .dist { text-align: right; }
form.sign { display: flex; gap: 8px; pointer-events: auto; }
form.sign[hidden] { display: none; }
form.sign input { font: 500 15px 'Geist Mono', monospace; padding: 9px 12px; width: 220px; border: 1px solid var(--fg); background: var(--paper); color: var(--fg); }
form.sign button { font: 500 13px 'Geist Mono', monospace; letter-spacing: 0.08em; text-transform: uppercase; padding: 9px 14px; border: 1px solid var(--fg); background: var(--fg); color: var(--paper); cursor: pointer; }
.err { color: var(--error); }
@media (max-width: 640px) { .row.bottom { flex-direction: column-reverse; align-items: stretch; } .right { text-align: left; justify-items: start; } form.sign input { width: 160px; } }
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
      <div class="label">Speed <b id="speed">0</b> m/s</div>
      <div class="label jump">Jump <span class="gauge"><i id="charge"></i></span></div>
    </div>
    <div class="stack right">
      <div class="label" id="status">Ready</div>
    </div>
  </div>
</div>
<div class="center">
  <div class="prompt" id="prompt">
    <h1>Hops Run</h1>
    <div class="label" id="result" hidden></div>
    <form class="sign" id="sign" hidden autocomplete="off">
      <input id="name" name="name" maxlength="20" placeholder="Your name" aria-label="Your name" required>
      <button type="submit">Add to board</button>
    </form>
    <div class="keys label"><span><b>Space</b> Fly</span><span>Steer ← → · Jump ↑ · Duck ↓</span></div>
    <div class="label">Leaderboard</div>
    <ol class="board" id="board">${boardRows(rows)}</ol>
  </div>
</div>
<script type="module" src="game.js"></script>
</body>
</html>`;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2kb' }));
app.get('/', async (_req, res, next) => {
  try { res.type('html').send(page(await board())); } catch (e) { next(e); }
});
app.get('/health', async (_req, res) => {
  try { await db.query('SELECT 1'); res.send('ok'); } catch { res.status(503).send('database unavailable'); }
});
app.get('/api/board', async (_req, res, next) => {
  try { const runs = await board(); res.json({ runs, html: boardRows(runs) }); } catch (e) { next(e); }
});
app.post('/api/runs', async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim(), distance = Math.floor(Number(req.body?.distance)), duration = Math.floor(Number(req.body?.durationMs));
    if (!NAME.test(name)) return res.status(400).json({ error: 'Name: 1 to 20 letters, digits, spaces, dots, dashes or underscores.' });
    if (!Number.isFinite(distance) || !Number.isFinite(duration) || distance < 0 || duration <= 0) return res.status(400).json({ error: 'Distance and duration must be positive numbers.' });
    if (distance > (duration / 1000) * MAX_SPEED) return res.status(400).json({ error: 'That run is faster than the hops can fly.' });
    const client = clientOf(req);
    if (!allowed(client)) return res.status(429).json({ error: 'Too many runs from here in the last minute. Try again shortly.' });
    const { rows: [run] } = await db.query(
      `INSERT INTO runs (name, distance_m, duration_ms, client) VALUES ($1, $2, $3, $4) RETURNING id, distance_m, created_at`,
      [name, distance, duration, client],
    );
    const { rows: [{ rank }] } = await db.query(
      `SELECT count(*)::int + 1 AS rank FROM runs WHERE distance_m > $1 OR (distance_m = $1 AND created_at < $2)`,
      [run.distance_m, run.created_at],
    );
    const runs = await board();
    res.json({ id: run.id, rank, runs, html: boardRows(runs) });
  } catch (e) { next(e); }
});
app.use('/vendor/three', express.static(fileURLToPath(new URL('node_modules/three/build/', import.meta.url)), { maxAge: '1d' }));
app.use(express.static(fileURLToPath(new URL('public/', import.meta.url))));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

const server = app.listen(cfg.port, '0.0.0.0', () => console.log(`hops-run on :${cfg.port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => db.end().then(() => process.exit(0))));
}
