// Hops Run: Express server for the game. Serves the page with the leaderboard rendered in the
// initial HTML, the three.js scene, and the leaderboard API backed by Postgres. Every run on the
// board carries its pilot (a player, Jev, or jevworks) and the model behind it, so players and
// decision models race on one board.
//
// Settings (env):
//   PORT              listen port
//   DATABASE_URL      postgres://user:password@host:5432/db
//   MAX_PLAYERS       players flying at once; beyond it, visitors wait in a live queue
//   BOARD_SIZE        rows on the leaderboard (default 10)
//   UMAMI_SRC         Umami tracker script URL (analytics off when unset)
//   UMAMI_WEBSITE_ID  Umami website id (analytics off when unset)
//   PILOT_TOKEN_SHA256  sha256 (hex) of the bearer token a model pilot posts its runs with
//                       (model pilot runs refused when unset)
//   LIVE_YOUTUBE_CHANNEL  YouTube channel id streaming the jevworks pilot: the start screen shows
//                         its live preview (none when unset)

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';

// The game version is package.json's: shown in the HUD and stored with every run, so a change to
// the track or physics never mixes incomparable runs without trace.
const VERSION = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')).version;

const cfg = {
  port: Number(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL,
  boardSize: Number(process.env.BOARD_SIZE ?? 10),
  maxPlayers: Number(process.env.MAX_PLAYERS),
  liveChannel: process.env.LIVE_YOUTUBE_CHANNEL || null,
  pilotToken: process.env.PILOT_TOKEN_SHA256 ? Buffer.from(process.env.PILOT_TOKEN_SHA256, 'hex') : null,
  umami: process.env.UMAMI_SRC && process.env.UMAMI_WEBSITE_ID ? { src: process.env.UMAMI_SRC, id: process.env.UMAMI_WEBSITE_ID } : null,
};
if (!cfg.port || !cfg.databaseUrl || !(cfg.maxPlayers > 0)) throw new Error('missing setting: PORT, DATABASE_URL and MAX_PLAYERS are required');

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
  ALTER TABLE runs ADD COLUMN IF NOT EXISTS game_version text;
  CREATE INDEX IF NOT EXISTS runs_distance ON runs (distance_m DESC, created_at);
  CREATE INDEX IF NOT EXISTS runs_pilot_distance ON runs (pilot, distance_m DESC, created_at);
`);
// Model pilots, as allowed by the table. A model pilot posts every run it flies, and each run
// ranks on the board like a player's.
const PILOTS = ['jev', 'jevworks'];

// Game limits, mirrored from public/game.js: no run covers more than top speed plus a full boost
// for its whole duration. Anything beyond is refused.
const MAX_SPEED = 160 + 45; // m/s
const NAME = /^[\p{L}\p{N} ._-]{1,20}$/u;
const SUBMIT = { perMinute: 6 };

async function board() {
  const { rows } = await db.query(
    `SELECT name, pilot, model, distance_m, game_version, created_at FROM runs ORDER BY distance_m DESC, created_at ASC LIMIT $1`,
    [cfg.boardSize],
  );
  return rows;
}

// Muted preview of the pilot's live stream; a click opens the stream on YouTube.
const liveCard = (channel) => `<a class="live" id="live" href="https://www.youtube.com/channel/${esc(channel)}/live" target="_blank" rel="noopener">
  <iframe data-src="https://www.youtube-nocookie.com/embed/live_stream?channel=${esc(channel)}&amp;autoplay=1&amp;mute=1&amp;controls=0&amp;playsinline=1" src="https://www.youtube-nocookie.com/embed/live_stream?channel=${esc(channel)}&amp;autoplay=1&amp;mute=1&amp;controls=0&amp;playsinline=1" title="jevworks live on YouTube" allow="autoplay; encrypted-media" tabindex="-1"></iframe>
  <span class="label"><i class="dot"></i><b>jevworks</b> is flying live · watch</span>
</a>`;

// A model pilot proves itself with the bearer token whose sha256 is PILOT_TOKEN_SHA256.
function isPilot(req) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token || !cfg.pilotToken) return false;
  const hash = createHash('sha256').update(token).digest();
  return hash.length === cfg.pilotToken.length && timingSafeEqual(hash, cfg.pilotToken);
}

// Per-client submission budget, in memory: a minute window per hashed client address.
const recent = new Map();
function allowed(client) {
  const now = Date.now(), hits = (recent.get(client) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= SUBMIT.perMinute) return false;
  recent.set(client, [...hits, now]);
  return true;
}
// Seats: at most MAX_PLAYERS sessions play at once, the rest wait in arrival order. A page holds
// its session with a heartbeat; a session silent for TTL is dropped. A seated player idle for IDLE
// gives up the seat, only when someone is waiting. In memory: a restart empties seats and queue,
// and pages rejoin on their next heartbeat.
const SEAT = { heartbeatMs: 10_000, ttlMs: 30_000, idleMs: 120_000, perClient: 8 };
const seated = new Map(), waiting = new Map(); // id -> { client, seen, active }, in arrival order
function sweep(now) {
  for (const queue of [seated, waiting]) for (const [id, s] of queue) if (now - s.seen > SEAT.ttlMs) queue.delete(id);
  if (waiting.size) for (const [id, s] of seated) if (now - s.active > SEAT.idleMs) seated.delete(id);
  for (const [id, s] of waiting) {
    if (seated.size >= cfg.maxPlayers) break;
    waiting.delete(id); seated.set(id, s);
  }
}
function seat(id) {
  if (seated.has(id)) return { id, state: 'play', heartbeatMs: SEAT.heartbeatMs };
  const position = [...waiting.keys()].indexOf(id) + 1;
  return position ? { id, state: 'wait', position, heartbeatMs: SEAT.heartbeatMs } : { state: 'gone' };
}

const clientOf = (req) => createHash('sha256').update(String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',')[0].trim()).digest('hex').slice(0, 16);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Line robot in front of a model pilot's name. The slab in the scene draws the same path.
const ROBOT = '<svg class="bot" viewBox="0 0 16 16" aria-label="model"><path d="M8 1.5V4M3 4h10v8.5H3zM6 7.25h.5M9.5 7.25h.5M6 10h4M1.5 7v3M14.5 7v3"/></svg>';
const boardRows = (rows) => rows.length
  ? rows.map((r, i) => `<li><span class="rank">${String(i + 1).padStart(2, '0')}</span><span class="who">${r.pilot === 'player' ? '' : ROBOT}${esc(r.name)}${r.pilot === 'player' ? '' : ` <i class="pilot">${esc(r.pilot)}${r.model ? ` · ${esc(r.model)}` : ''}</i>`}</span><span class="dist">${r.distance_m} m <i class="ver">v${esc(r.game_version ?? '?')}</i></span></li>`).join('')
  : '<li class="empty">No runs yet. Be the first.</li>';

const page = (rows) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hops Run</title>
<meta name="description" content="Fly the hops through a procedural track of turns, loops and corkscrews. Dodge, jump and duck, then put your name on the leaderboard.">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
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
/* Cockpit: corner brackets and edge ticks frame the view, a reticle banks with the hops during a
   run, speed and jump read as graduated gauges. */
.canopy { position: fixed; inset: calc(var(--m) * 0.45); pointer-events: none; opacity: 0.45; --c: var(--fg); --l: 28px; --t: 10px; --w: 1.5px;
  background: linear-gradient(var(--c), var(--c)) 0 0 / var(--l) var(--w), linear-gradient(var(--c), var(--c)) 0 0 / var(--w) var(--l),
    linear-gradient(var(--c), var(--c)) 100% 0 / var(--l) var(--w), linear-gradient(var(--c), var(--c)) 100% 0 / var(--w) var(--l),
    linear-gradient(var(--c), var(--c)) 0 100% / var(--l) var(--w), linear-gradient(var(--c), var(--c)) 0 100% / var(--w) var(--l),
    linear-gradient(var(--c), var(--c)) 100% 100% / var(--l) var(--w), linear-gradient(var(--c), var(--c)) 100% 100% / var(--w) var(--l),
    linear-gradient(var(--c), var(--c)) 50% 0 / var(--w) var(--t), linear-gradient(var(--c), var(--c)) 50% 100% / var(--w) var(--t),
    linear-gradient(var(--c), var(--c)) 0 50% / var(--t) var(--w), linear-gradient(var(--c), var(--c)) 100% 50% / var(--t) var(--w);
  background-repeat: no-repeat; }
.reticle { position: fixed; left: 50%; top: 46%; width: 160px; transform: translate(-50%, -50%) rotate(var(--bank, 0deg)); pointer-events: none;
  fill: none; stroke: var(--fg); stroke-width: 1.5; stroke-linecap: round; opacity: 0; transition: opacity 0.3s; }
body.flying .reticle { opacity: 0.5; }
.jump { display: grid; grid-template-columns: 56px 140px auto; align-items: center; gap: 10px; }
.gauge { width: 140px; height: 2px; background: var(--rule); position: relative; }
.gauge.ticks::after { content: ''; position: absolute; left: 0; right: 0; bottom: 3px; height: 5px; opacity: 0.6;
  background: repeating-linear-gradient(90deg, var(--dim) 0 1px, transparent 1px 14px); }
.gauge i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--fg); }
.gauge i.full { background: var(--green); }
.mind { width: min(320px, 44vw); display: grid; gap: 8px; }
.mind[hidden], #pilot[hidden] { display: none; }
.move { display: grid; grid-template-columns: 56px 1fr 52px; align-items: center; gap: 10px; font-family: 'Geist Mono', monospace; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); }
.move .bar { height: 2px; background: var(--rule); position: relative; }
.move .bar i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--dim); }
.move .p { text-align: right; }
.move.pick { color: var(--fg); }
.move.pick .bar i { background: var(--green); }
.move.off { opacity: 0.3; }
#status.crash { color: var(--error); }
#status.flying { color: var(--fg); }
.center { position: fixed; inset: 0; display: grid; place-items: start center; pointer-events: none; padding: max(4vh, 28px) var(--m) var(--m); }
.prompt { text-align: center; display: grid; gap: 18px; justify-items: center; }
.prompt h1 { font-size: clamp(36px, 6vw, 72px); font-weight: 600; letter-spacing: -0.055em; margin: 0; line-height: 0.95; }
.prompt[hidden] { display: none; }
.keys { display: flex; gap: 24px; justify-content: center; flex-wrap: wrap; }
.keys[hidden] { display: none; }
.board { width: min(420px, 100%); margin: 6px 0 0; padding: 0; list-style: none; font-family: 'Geist Mono', monospace; font-size: 14px; text-align: left; background: color-mix(in srgb, var(--paper) 80%, transparent); border: 1px solid var(--rule); }
.board li { display: grid; grid-template-columns: 34px 1fr auto; gap: 10px; padding: 7px 12px; border-top: 1px solid var(--rule); }
.board li:first-child { border-top: 0; }
.board li.you { background: color-mix(in srgb, var(--green) 12%, transparent); }
.board li.empty { display: block; color: var(--dim); text-align: center; }
.board .rank { color: var(--dim); }
.board .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board .bot { width: 14px; height: 14px; margin-right: 6px; vertical-align: -2px; fill: none; stroke: var(--green); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.board .pilot {color: var(--green); font-style: normal; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
.board .dist { text-align: right; }
.board .ver { color: var(--dim); font-style: normal; font-size: 11px; margin-left: 6px; }
form.sign { display: flex; gap: 8px; pointer-events: auto; }
form.sign[hidden] { display: none; }
form.sign input { font: 500 15px 'Geist Mono', monospace; padding: 9px 12px; width: 220px; border: 1px solid var(--fg); background: var(--paper); color: var(--fg); }
form.sign button { font: 500 13px 'Geist Mono', monospace; letter-spacing: 0.08em; text-transform: uppercase; padding: 9px 14px; border: 1px solid var(--fg); background: var(--fg); color: var(--paper); cursor: pointer; }
.err { color: var(--error); }
.live { position: fixed; top: calc(var(--m) + 44px); right: var(--m); width: 256px; display: grid; gap: 8px; text-decoration: none; pointer-events: auto; }
.live[hidden] { display: none; }
.live iframe { width: 256px; height: 144px; border: 1px solid var(--rule); background: var(--fg); pointer-events: none; display: block; }
.live .label { display: flex; align-items: center; gap: 8px; justify-content: flex-end; white-space: nowrap; }
.live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
.in-world .board, .in-world .board-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 640px) { .live { width: auto; } .live iframe { display: none; } .mind { width: 100%; } .row.bottom { flex-direction: column-reverse; align-items: stretch; } .right { text-align: left; justify-items: start; } form.sign input { width: 160px; } }
</style>
<script type="importmap">{ "imports": { "three": "./vendor/three/three.module.js" } }</script>
${cfg.umami ? `<script defer src="${esc(cfg.umami.src)}" data-website-id="${esc(cfg.umami.id)}"></script>` : ''}
</head>
<body>
<canvas id="scene"></canvas>
<div class="grain"></div>
<div class="flash"></div>
${cfg.liveChannel ? liveCard(cfg.liveChannel) : ''}
<div class="canopy"></div>
<svg class="reticle" id="reticle" viewBox="-80 -14 160 28" aria-hidden="true"><path d="M-76 0h34M42 0h34M-12 8l12-7 12 7M-42 0v5M42 0v5"/></svg>
<div class="hud">
  <div class="row">
    <img class="mark" src="hw.svg" alt="Hopsworks">
    <div class="label">Hops Run <b>v${VERSION}</b></div>
  </div>
  <div></div>
  <div class="row bottom">
    <div class="stack">
      <div class="metric" id="distance">0<small>m</small></div>
      <div class="label jump"><span>Speed</span><span class="gauge ticks"><i id="speedbar"></i></span><span><b id="speed">0</b> m/s</span></div>
      <div class="label jump"><span>Jump</span><span class="gauge ticks"><i id="charge"></i></span></div>
    </div>
    <div class="stack right">
      <div class="mind" id="mind" hidden>
        ${['left', 'hold', 'right', 'up', 'down'].map((m) => `<div class="move" data-move="${m}"><span>${m}</span><span class="bar"><i></i></span><span class="p">-</span></div>`).join('')}
      </div>
      <div class="label" id="pilot" hidden></div>
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
    <div class="label" id="seat" hidden></div>
    <div class="keys label"><span><b>Space</b> Fly</span><span>Steer ← → · Jump ↑ · Duck ↓</span></div>
    <div class="label board-label">Leaderboard</div>
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
  try { await db.query('SELECT 1'); sweep(Date.now()); res.json({ status: 'ok', version: VERSION, players: seated.size, waiting: waiting.size, maxPlayers: cfg.maxPlayers }); } catch { res.status(503).send('database unavailable'); }
});
// Join with no id, or heartbeat with the id from the join: `active` when the player did something
// since the last beat. Answers the seat: play, wait (with position), or gone (join again).
app.post('/api/seat', (req, res) => {
  const now = Date.now(), id = String(req.body?.id ?? ''), known = seated.get(id) ?? waiting.get(id);
  if (known) {
    known.seen = now;
    if (req.body?.active) known.active = now;
  } else if (!id) {
    const client = clientOf(req);
    if ([...seated.values(), ...waiting.values()].filter((s) => s.client === client).length >= SEAT.perClient) return res.status(429).json({ error: 'Too many open games from here. Close one and try again.' });
    const fresh = randomUUID();
    waiting.set(fresh, { client, seen: now, active: now });
    sweep(now);
    return res.json(seat(fresh));
  }
  sweep(now);
  res.json(seat(id));
});
app.post('/api/seat/leave', (req, res) => {
  const id = String(req.body?.id ?? '');
  seated.delete(id); waiting.delete(id);
  sweep(Date.now());
  res.status(204).end();
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
    if (req.headers.authorization) {
      if (!isPilot(req)) return res.status(401).json({ error: 'Unknown pilot token.' });
      const pilot = String(req.body?.pilot ?? ''), model = String(req.body?.model ?? '').slice(0, 64) || null;
      if (!PILOTS.includes(pilot)) return res.status(400).json({ error: `Pilot: one of ${PILOTS.join(', ')}.` });
      await db.query(
        `INSERT INTO runs (name, pilot, model, distance_m, duration_ms, client, game_version) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [name, pilot, model, distance, duration, client, VERSION],
      );
      const { rows: [{ number, best }] } = await db.query(`SELECT count(*)::int AS number, max(distance_m) AS best FROM runs WHERE pilot = $1`, [pilot]);
      const runs = await board();
      return res.json({ number, best, runs, html: boardRows(runs) });
    }
    if (!allowed(client)) return res.status(429).json({ error: 'Too many runs from here in the last minute. Try again shortly.' });
    const { rows: [run] } = await db.query(
      `INSERT INTO runs (name, distance_m, duration_ms, client, game_version) VALUES ($1, $2, $3, $4, $5) RETURNING id, distance_m, created_at`,
      [name, distance, duration, client, VERSION],
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
