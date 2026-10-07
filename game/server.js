// Hops Run: Express server for the game. Serves the page with the leaderboards rendered in the
// initial HTML, the three.js scene, and the leaderboard API backed by Postgres. Every run carries
// its pilot (a player, a model pilot: jev, qwen, kumo, clef, or a bot from the repo's bots/) and the
// model behind it, and the edition it was flown on: classic, or one a designer published. Three
// boards per edition: players and model pilots, bots, and the editions themselves.
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
//   PUBLIC_URL        public origin, e.g. https://game.hopsworks.ai/: canonical link and share card
//                     (no share card when unset)
//   LIVE_YOUTUBE_CHANNEL  YouTube channel id streaming the model pilots: the start screen shows
//                         its live preview (none when unset)
//   LIVE_YOUTUBE_VIDEO    YouTube video id of the pilots' broadcast: the preview plays it instead of
//                         the channel's current live, which is another broadcast while the channel runs two

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';
import { SPEED, BOOST, PAD_GAP, CLASSIC, checkEdition } from './public/sim.js';

// The game version is package.json's: shown in the HUD and stored with every run, so a change to
// the track or physics never mixes incomparable runs without trace.
const VERSION = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')).version;

const cfg = {
  port: Number(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL,
  boardSize: Number(process.env.BOARD_SIZE ?? 10),
  maxPlayers: Number(process.env.MAX_PLAYERS),
  publicUrl: process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).href : null,
  liveChannel: process.env.LIVE_YOUTUBE_CHANNEL || null,
  liveVideo: process.env.LIVE_YOUTUBE_VIDEO || null,
  pilotToken: process.env.PILOT_TOKEN_SHA256 ? Buffer.from(process.env.PILOT_TOKEN_SHA256, 'hex') : null,
  umami: process.env.UMAMI_SRC && process.env.UMAMI_WEBSITE_ID ? { src: process.env.UMAMI_SRC, id: process.env.UMAMI_WEBSITE_ID } : null,
};
if (!cfg.port || !cfg.databaseUrl || !(cfg.maxPlayers > 0)) throw new Error('missing setting: PORT, DATABASE_URL and MAX_PLAYERS are required');

// Model pilots, as allowed by the table. A model pilot posts every run it flies, and each run
// ranks on the board like a player's. Bots (pilot 'bot') post with the same token, from the arena,
// and rank on a board of their own.
const PILOTS = ['jev', 'qwen', 'kumo', 'clef'];
const BOT = 'bot';

// The pool lives for the process and is closed on shutdown.
const db = new pg.Pool({ connectionString: cfg.databaseUrl, max: 5 });
await db.query(`
  CREATE TABLE IF NOT EXISTS runs (
    id          bigserial PRIMARY KEY,
    name        text NOT NULL,
    pilot       text NOT NULL DEFAULT 'player',
    model       text,
    distance_m  integer NOT NULL CHECK (distance_m >= 0),
    duration_ms integer NOT NULL CHECK (duration_ms > 0),
    client      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE runs ADD COLUMN IF NOT EXISTS game_version text;
  CREATE INDEX IF NOT EXISTS runs_distance ON runs (distance_m DESC, created_at);
  CREATE INDEX IF NOT EXISTS runs_pilot_distance ON runs (pilot, distance_m DESC, created_at);
  ALTER TABLE runs ADD COLUMN IF NOT EXISTS run_key uuid;
  CREATE UNIQUE INDEX IF NOT EXISTS runs_run_key ON runs (run_key);
  CREATE TABLE IF NOT EXISTS run_starts (
    run_key    uuid PRIMARY KEY,
    client     text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS run_starts_started_at ON run_starts (started_at);
  ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_pilot_check;
  -- The SemIf pilot on Qwen was named after its project (jevworks) until v1.11.0.
  UPDATE runs SET pilot = 'qwen', name = 'qwen' WHERE pilot = 'jevworks';
  ALTER TABLE runs ADD CONSTRAINT runs_pilot_check CHECK (pilot IN (${['player', BOT, ...PILOTS].map((p) => `'${p}'`).join(', ')}));
  CREATE TABLE IF NOT EXISTS editions (
    slug         text PRIMARY KEY,
    spec         jsonb NOT NULL,
    designer     text NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE runs ADD COLUMN IF NOT EXISTS edition text NOT NULL DEFAULT 'classic';
  CREATE INDEX IF NOT EXISTS runs_edition_distance ON runs (edition, distance_m DESC, created_at);
`);
// Classic is the game's own edition (public/sim.js), kept in step with it.
await db.query(`INSERT INTO editions (slug, spec, designer, published_at) VALUES ('classic', $1, 'Hops Run', 'epoch')
  ON CONFLICT (slug) DO UPDATE SET spec = EXCLUDED.spec`, [CLASSIC]);

// A player's run is timed by the server: at takeoff the page asks for a run key, and the server
// records when. The run posted with that key may last no longer than the time since its takeoff,
// and cover no more than the hops can fly in that time: the speed curve, plus a boost gate at
// most every PAD_GAP.min metres (each worth kick^2 / (2 decay) metres), with a margin. The
// constants are the game's own (public/sim.js).
const PHYSICS = { margin: 1.05, clockSlackMs: 3000 };
function maxDistance(durationMs) {
  const t = durationMs / 1000, ramp = (SPEED.max - SPEED.start) / SPEED.gain;
  const base = t <= ramp ? SPEED.start * t + (SPEED.gain * t * t) / 2 : SPEED.start * ramp + (SPEED.gain * ramp * ramp) / 2 + SPEED.max * (t - ramp);
  const perGate = BOOST.kick ** 2 / (2 * BOOST.decay);
  return ((base + perGate) / (1 - perGate / PAD_GAP.min)) * PHYSICS.margin;
}
const NAME = /^[\p{L}\p{N} ._-]{1,20}$/u;
const SUBMIT = { perMinute: 6 }, STARTS = { perMinute: 30, keepHours: 24 };
// Posting a run key again (a retry, a second click) records nothing new and answers with the run
// already recorded.
const RUN_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const findRun = async (runKey) => (await db.query(`SELECT id, distance_m, created_at FROM runs WHERE run_key = $1`, [runKey])).rows[0];
async function recordRun({ name, pilot, model, distance, duration, client, runKey, edition }) {
  const { rows: [run] } = await db.query(
    `INSERT INTO runs (name, pilot, model, distance_m, duration_ms, client, game_version, run_key, edition) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (run_key) DO NOTHING RETURNING id, distance_m, created_at`,
    [name, pilot, model, distance, duration, client, VERSION, runKey, edition],
  );
  return run ?? findRun(runKey); // a concurrent post of the same key won the insert
}

// Editions: classic, and the live one (the latest a designer published), as the page loads them.
const SLUG = /^[a-z0-9][a-z0-9.:-]{0,39}$/;
async function editions() {
  const { rows } = await db.query(`SELECT slug, spec, designer, published_at FROM editions WHERE slug = 'classic' OR published_at = (SELECT max(published_at) FROM editions WHERE slug <> 'classic')`);
  return { classic: rows.find((e) => e.slug === 'classic'), live: rows.find((e) => e.slug !== 'classic') ?? null };
}
const editionOf = async (slug) => (await db.query(`SELECT slug, spec, designer, published_at FROM editions WHERE slug = $1`, [slug])).rows[0];

// A board of runs on one edition: the top runs, ranked. On the players' board (players and model
// pilots) the best player and each model pilot missing from the top follow, with its best run and
// that run's place, so players and every model stay on it whoever leads; each model pilot's first
// row carries how many runs it has flown there. The bots' board is the bots' runs alone.
async function board(edition, bots = false) {
  const who = bots ? `pilot = '${BOT}'` : `pilot <> '${BOT}'`;
  const { rows } = await db.query(
    `SELECT name, pilot, model, distance_m, game_version, created_at FROM runs WHERE edition = $1 AND ${who} ORDER BY distance_m DESC, created_at ASC LIMIT $2`,
    [edition, cfg.boardSize],
  );
  const top = rows.map((r, i) => ({ ...r, rank: i + 1 }));
  if (bots) return top;
  const missing = ['player', ...PILOTS].filter((p) => !top.some((r) => r.pilot === p));
  const { rows: below } = await db.query(
    `SELECT b.*, 1 + (SELECT count(*) FROM runs o WHERE o.edition = $2 AND o.${who} AND (o.distance_m > b.distance_m OR (o.distance_m = b.distance_m AND o.created_at < b.created_at)))::int AS rank
     FROM unnest($1::text[]) AS p(pilot) CROSS JOIN LATERAL
       (SELECT name, pilot, model, distance_m, game_version, created_at FROM runs WHERE runs.pilot = p.pilot AND runs.edition = $2 ORDER BY distance_m DESC, created_at LIMIT 1) b
     ORDER BY rank`,
    [missing, edition],
  );
  const { rows: counts } = await db.query(`SELECT pilot, count(*)::int AS runs FROM runs WHERE pilot = ANY($1) AND edition = $2 GROUP BY pilot`, [PILOTS, edition]);
  const flown = new Map(counts.map((c) => [c.pilot, c.runs]));
  return [...top, ...below.map((r) => ({ ...r, below: true }))].map((r) => {
    const runs = flown.get(r.pilot);
    flown.delete(r.pilot);
    return runs ? { ...r, pilotRuns: runs } : r;
  });
}
// The editions, newest first, each with how many runs were flown on it and the best.
async function editionBoard() {
  const { rows } = await db.query(
    `SELECT e.slug, e.designer, e.published_at, count(r.id)::int AS runs, coalesce(max(r.distance_m), 0) AS best
     FROM editions e LEFT JOIN runs r ON r.edition = e.slug GROUP BY e.slug ORDER BY e.published_at DESC LIMIT $1`,
    [cfg.boardSize],
  );
  return rows;
}
const boards = async (edition) => ({ players: await board(edition), bots: await board(edition, true), editions: await editionBoard() });
const boardsHtml = (b) => ({ players: boardRows(b.players), bots: boardRows(b.bots, 'No bot has flown this edition yet.'), editions: editionRows(b.editions) });

// Muted preview of the pilot's live stream; a click opens the stream on YouTube. With a video id it plays
// that broadcast, else the channel's current live. data-channel names the channel the stream goes to
// (pilot/deploy.py reads it).
const liveCard = ({ channel, video }) => {
  const embed = (video ? `https://www.youtube-nocookie.com/embed/${esc(video)}?` : `https://www.youtube-nocookie.com/embed/live_stream?channel=${esc(channel)}&amp;`)
    + 'autoplay=1&amp;mute=1&amp;controls=0&amp;playsinline=1';
  const href = video ? `https://www.youtube.com/watch?v=${esc(video)}` : `https://www.youtube.com/channel/${esc(channel)}/live`;
  return `<a class="live" id="live" href="${href}"${channel ? ` data-channel="${esc(channel)}"` : ''} target="_blank" rel="noopener">
  <span class="label head"><span>Feed · <b>AI pilots</b></span><span class="on"><i class="dot"></i>Live</span></span>
  <span class="screen brackets"><iframe data-src="${embed}" src="${embed}" title="AI pilots live on YouTube" allow="autoplay; encrypted-media" tabindex="-1"></iframe></span>
</a>`;
};

// A model pilot proves itself with the bearer token whose sha256 is PILOT_TOKEN_SHA256.
function isPilot(req) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token || !cfg.pilotToken) return false;
  const hash = createHash('sha256').update(token).digest();
  return hash.length === cfg.pilotToken.length && timingSafeEqual(hash, cfg.pilotToken);
}

// Per-client budgets, in memory: a minute window per hashed client address.
function budget(perMinute) {
  const recent = new Map();
  return (client) => {
    const now = Date.now(), hits = (recent.get(client) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= perMinute) return false;
    recent.set(client, [...hits, now]);
    return true;
  };
}
const allowed = budget(SUBMIT.perMinute), startAllowed = budget(STARTS.perMinute);
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
// Line icon in front of each name: a robot for a model pilot, a person for a player. The slab in
// the scene draws the same paths.
const ROBOT = '<svg class="icon bot" viewBox="0 0 16 16" aria-label="model"><path d="M8 1.5V4M3 4h10v8.5H3zM6 7.25h.5M9.5 7.25h.5M6 10h4M1.5 7v3M14.5 7v3"/></svg>';
const PERSON = '<svg class="icon human" viewBox="0 0 16 16" aria-label="player"><path d="M8 2a2.75 2.75 0 1 1 0 5.5a2.75 2.75 0 1 1 0-5.5zM2.5 14.5c0-3.2 2.4-5.25 5.5-5.25s5.5 2.05 5.5 5.25"/></svg>';
// Who built each model pilot, credited on its rows.
const MAKERS = {
  jev: { name: 'TypeSafe', url: 'https://typesafe.ai' },
  qwen: { name: 'SemIf', url: 'https://github.com/TheoLeeCJ/SemIf' },
  kumo: { name: 'NVIDIA', url: 'https://huggingface.co/nvidia/Kumo-Tabular' },
  clef: { name: 'Cloudflare', url: 'https://huggingface.co/Cloudflare/clef-flash' },
};
const pilotTag = (r) => {
  const maker = MAKERS[r.pilot];
  return ` <i class="pilot">${esc(r.pilot)}${r.model ? ` · ${esc(r.model)}` : ''}${r.pilotRuns ? ` · ${r.pilotRuns} runs` : ''}${maker ? ` · by <a href="${maker.url}" target="_blank" rel="noopener">${maker.name}</a>` : ''}</i>`;
};
const boardRow = (r) => `<li data-rank="${r.rank}"${r.below ? ' class="below"' : ''}><span class="rank">${String(r.rank).padStart(2, '0')}</span><span class="who">${r.pilot === 'player' ? PERSON : ROBOT}${esc(r.name)}${r.pilot === 'player' ? '' : pilotTag(r)}</span><span class="dist">${r.distance_m} m <i class="ver">v${esc(r.game_version ?? '?')}</i></span></li>`;
const boardRows = (rows, empty = 'No runs yet. Be the first.') => rows.length
  ? rows.map((r, i) => `${r.below && !rows[i - 1]?.below ? '<li class="gap" aria-hidden="true">···</li>' : ''}${boardRow(r)}`).join('')
  : `<li class="empty">${esc(empty)}</li>`;
// An edition's row, newest first: its name, its designer, when it was published, its runs and best.
const editionRows = (rows) => rows.map((e, i) => `<li data-edition="${esc(e.slug)}"><span class="rank">${String(i + 1).padStart(2, '0')}</span><span class="who">${esc(e.slug)} <i class="pilot">by ${esc(e.designer)}${e.slug === 'classic' ? '' : ` · ${e.published_at.toISOString().slice(0, 10)}`} · ${e.runs} runs</i></span><span class="dist">${e.best} m</span></li>`).join('');

// Shared links (Open Graph, X): the page's title and description, and public/og.jpg, a 1200x630
// capture of the game.
const DESCRIPTION = 'Fly the hops through turns, loops and corkscrews, and beat the AI pilots flying live on the same leaderboard.';
const shareCard = (url) => `<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Hopsworks">
<meta property="og:title" content="Hops Run">
<meta property="og:description" content="${esc(DESCRIPTION)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(new URL('og.jpg', url).href)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Hops Run: the hops flying down the track in the Hopsworks paper style">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Hops Run">
<meta name="twitter:description" content="${esc(DESCRIPTION)}">
<meta name="twitter:image" content="${esc(new URL('og.jpg', url).href)}">`;

const page = ({ boards: b, editions: e, edition }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hops Run</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<meta name="theme-color" content="#F1EFEA">
${cfg.publicUrl ? shareCard(cfg.publicUrl) : ''}
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
.brackets { --c: var(--fg); --l: 28px; --w: 1.5px; background-repeat: no-repeat;
  background-image: linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c)),
    linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c)), linear-gradient(var(--c), var(--c));
  background-position: 0 0, 0 0, 100% 0, 100% 0, 0 100%, 0 100%, 100% 100%, 100% 100%;
  background-size: var(--l) var(--w), var(--w) var(--l), var(--l) var(--w), var(--w) var(--l), var(--l) var(--w), var(--w) var(--l), var(--l) var(--w), var(--w) var(--l); }
.canopy { position: fixed; inset: calc(var(--m) * 0.45); pointer-events: none; opacity: 0.45; }
.canopy::after { content: ''; position: absolute; inset: 0; --t: 10px; --w: 1.5px; background-repeat: no-repeat;
  background-image: linear-gradient(var(--fg), var(--fg)), linear-gradient(var(--fg), var(--fg)), linear-gradient(var(--fg), var(--fg)), linear-gradient(var(--fg), var(--fg));
  background-position: 50% 0, 50% 100%, 0 50%, 100% 50%;
  background-size: var(--w) var(--t), var(--w) var(--t), var(--t) var(--w), var(--t) var(--w); }
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
.board li.gap { display: block; color: var(--dim); text-align: center; padding: 0 12px; line-height: 1.2; }
.board .pilot a { color: inherit; pointer-events: auto; }
.board[hidden] { display: none; }
/* The track picks sit at the bottom centre, between the distance and the status. */
.picks { position: fixed; left: 50%; bottom: var(--m); transform: translateX(-50%); display: grid; gap: 8px; justify-items: center; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; pointer-events: auto; }
.tabs button { font: 500 12px 'Geist Mono', monospace; letter-spacing: 0.08em; text-transform: uppercase; padding: 5px 10px; border: 1px solid var(--rule); background: var(--paper); color: var(--dim); cursor: pointer; }
.tabs button[aria-pressed="true"] { border-color: var(--fg); color: var(--fg); }
.tabs.track button[aria-pressed="true"] { border-color: var(--green); color: var(--green); }
#top { color: var(--green); }
#top[hidden] { display: none; }
.prompt .links { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
.prompt .more { display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border: 1px solid var(--green); border-radius: 999px; color: var(--green); background: var(--paper); text-decoration: none; pointer-events: auto; }
.prompt .more svg { width: 14px; height: 14px; fill: currentColor; flex: none; }
.prompt .more:hover, .prompt .more:focus-visible { background: var(--green); color: var(--paper); outline: none; }
.board .rank { color: var(--dim); }
.board .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board .icon { width: 14px; height: 14px; margin-right: 6px; vertical-align: -2px; fill: none; stroke: var(--green); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.board .icon.human { stroke: var(--fg); }
.board .pilot {color: var(--green); font-style: normal; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
.board .dist { text-align: right; }
.board .ver { color: var(--dim); font-style: normal; font-size: 11px; margin-left: 6px; }
form.sign { display: flex; gap: 8px; pointer-events: auto; }
form.sign[hidden] { display: none; }
form.sign input { font: 500 15px 'Geist Mono', monospace; padding: 9px 12px; width: 220px; border: 1px solid var(--fg); background: var(--paper); color: var(--fg); }
form.sign button { font: 500 13px 'Geist Mono', monospace; letter-spacing: 0.08em; text-transform: uppercase; padding: 9px 14px; border: 1px solid var(--fg); background: var(--fg); color: var(--paper); cursor: pointer; }
.err { color: var(--error); }
.live { position: fixed; top: calc(var(--m) + 40px); right: calc(var(--m) - 6px); width: 268px; display: grid; gap: 4px; text-decoration: none; pointer-events: auto; }
.live[hidden] { display: none; }
.live .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 0 6px; white-space: nowrap; overflow: hidden; }
.live .head span { overflow: hidden; text-overflow: ellipsis; }
.live .on { display: flex; align-items: center; gap: 6px; color: var(--fg); }
.live .screen { display: block; padding: 6px; --l: 16px; --c: var(--dim); }
.live iframe { width: 256px; height: 144px; border: 1px solid var(--rule); background: var(--fg); pointer-events: none; display: block; }
.live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
.in-world .board, .in-world .board-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 640px) { .picks { position: static; transform: none; } .live { width: auto; } .live .screen { display: none; } .mind { width: 100%; } .row.bottom { flex-direction: column-reverse; align-items: stretch; } .right { text-align: left; justify-items: start; } form.sign input { width: 160px; } }
</style>
<script type="importmap">{ "imports": { "three": "./vendor/three/three.module.js" } }</script>
${cfg.umami ? `<script defer src="${esc(cfg.umami.src)}" data-website-id="${esc(cfg.umami.id)}"></script>` : ''}
</head>
<body>
<canvas id="scene"></canvas>
<div class="grain"></div>
<div class="flash"></div>
${cfg.liveChannel || cfg.liveVideo ? liveCard({ channel: cfg.liveChannel, video: cfg.liveVideo }) : ''}
<div class="canopy brackets"></div>
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
      <div class="label jump"><span>Speed</span><span class="gauge ticks"><i id="speedbar"></i></span><span><b id="speed">0</b> m/s<b id="top" hidden> · max</b></span></div>
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
    <div class="keys label"><span><b>Space</b> Fly</span><span>Steer ← → · Jump ↑ · Duck ↓</span><span>${e.live ? '<b>T</b> Track · ' : ''}<b>B</b> Boards</span></div>
    <div class="picks">
    <div class="tabs track" id="track" role="group" aria-label="Track">
      <button type="button" data-track="classic" aria-pressed="${edition.slug === 'classic'}">Classic</button>
      ${e.live ? `<button type="button" data-track="live" aria-pressed="${edition.slug === e.live.slug}" title="${esc(e.live.spec.describe ?? '')}">Live · ${esc(e.live.slug)}</button>` : ''}
    </div>
    </div>
    <div class="label board-label" id="board-label">Leaderboard · ${esc(edition.slug)}</div>
    <ol class="board" id="board" data-board="players">${boardRows(b.players)}</ol>
    <ol class="board" data-board="bots" hidden>${boardRows(b.bots, 'No bot has flown this edition yet.')}</ol>
    <ol class="board" data-board="editions" hidden>${editionRows(b.editions)}</ol>
    <div class="links">
      <a class="label more" href="https://github.com/MagicLex/hops-run" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Know more about the project</a>
      <a class="label more" href="https://github.com/MagicLex/hops-run/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Submit your bot</a>
    </div>
  </div>
</div>
<script type="application/json" id="editions">${JSON.stringify({ edition: edition.slug, classic: e.classic.spec, live: e.live && { slug: e.live.slug, spec: e.live.spec } }).replace(/</g, '\\u003c')}</script>
<script type="module" src="game.js"></script>
</body>
</html>`;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
// Link-preview crawlers are logged with what they got, so a missing share card can be traced.
const PREVIEW_BOTS = /LinkedInBot|facebookexternalhit|Facebot|WhatsApp|Slackbot|Twitterbot|TelegramBot|Discordbot|Googlebot|bingbot|Applebot/i;
app.use((req, res, next) => {
  const bot = PREVIEW_BOTS.exec(req.headers['user-agent'] ?? '')?.[0];
  if (bot) res.on('finish', () => console.log(`preview ${bot} ${req.method} ${req.originalUrl} ${res.statusCode}`));
  next();
});
// The edition a page or a board asks for: ?edition=classic (the default), live, or a slug.
async function chosen(req) {
  const e = await editions(), asked = String(req.query.edition ?? 'classic');
  const edition = asked === 'live' ? e.live ?? e.classic : asked === 'classic' ? e.classic : SLUG.test(asked) ? await editionOf(asked) : null;
  return { editions: e, edition: edition ?? e.classic };
}
app.get('/', async (req, res, next) => {
  try { const { editions: e, edition } = await chosen(req); res.type('html').send(page({ boards: await boards(edition.slug), editions: e, edition })); } catch (err) { next(err); }
});
app.get('/health', async (_req, res) => {
  try { const { live } = await editions(); sweep(Date.now()); res.json({ status: 'ok', version: VERSION, edition: live?.slug ?? 'classic', players: seated.size, waiting: waiting.size, maxPlayers: cfg.maxPlayers }); } catch { res.status(503).send('database unavailable'); }
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
app.get('/api/board', async (req, res, next) => {
  try { const { edition } = await chosen(req), b = await boards(edition.slug); res.json({ edition: edition.slug, runs: b.players, html: boardRows(b.players), boards: boardsHtml(b) }); } catch (e) { next(e); }
});
// The editions, newest first, with their runs and best: what a designer looks back on.
app.get('/api/editions', async (_req, res, next) => {
  try {
    const rows = await editionBoard();
    const { rows: specs } = await db.query(`SELECT slug, spec FROM editions WHERE slug = ANY($1)`, [rows.map((e) => e.slug)]);
    const spec = new Map(specs.map((e) => [e.slug, e.spec]));
    res.json({ editions: rows.map((e) => ({ ...e, spec: spec.get(e.slug) })) });
  } catch (e) { next(e); }
});
// A designer publishes an edition: it goes live at once. Checked against the game's own bounds.
app.post('/api/editions', async (req, res, next) => {
  try {
    if (!isPilot(req)) return res.status(401).json({ error: 'Unknown pilot token.' });
    const slug = String(req.body?.slug ?? ''), designer = String(req.body?.designer ?? '').slice(0, 64), spec = req.body?.spec;
    if (!SLUG.test(slug) || slug === 'classic' || slug === 'live') return res.status(400).json({ error: 'Slug: lowercase letters, digits, dots, colons and dashes, not classic or live.' });
    if (!designer) return res.status(400).json({ error: 'Designer: the model that made it.' });
    try { checkEdition({ ...spec, name: slug }); } catch (e) { return res.status(400).json({ error: e.message }); }
    const { rowCount } = await db.query(`INSERT INTO editions (slug, spec, designer) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING`, [slug, { ...spec, name: slug }, designer]);
    if (!rowCount) return res.status(409).json({ error: `Edition ${slug} exists.` });
    res.status(201).json({ slug });
  } catch (e) { next(e); }
});
// Takeoff: a run key for the run just started, timed from now.
app.post('/api/runs/start', async (req, res, next) => {
  try {
    const client = clientOf(req);
    if (!startAllowed(client)) return res.status(429).json({ error: 'Too many runs from here in the last minute. Try again shortly.' });
    const runKey = randomUUID();
    await db.query(`DELETE FROM run_starts WHERE started_at < now() - make_interval(hours => $1)`, [STARTS.keepHours]);
    await db.query(`INSERT INTO run_starts (run_key, client) VALUES ($1, $2)`, [runKey, client]);
    res.json({ runKey });
  } catch (e) { next(e); }
});
app.post('/api/runs', async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim(), distance = Math.floor(Number(req.body?.distance)), duration = Math.floor(Number(req.body?.durationMs));
    if (!NAME.test(name)) return res.status(400).json({ error: 'Name: 1 to 20 letters, digits, spaces, dots, dashes or underscores.' });
    if (!Number.isFinite(distance) || !Number.isFinite(duration) || distance < 0 || duration <= 0) return res.status(400).json({ error: 'Distance and duration must be positive numbers.' });
    if (distance > maxDistance(duration)) return res.status(400).json({ error: 'That run is further than the hops can fly in its time.' });
    const runKey = req.body?.runKey == null ? null : String(req.body.runKey);
    if (runKey !== null && !RUN_KEY.test(runKey)) return res.status(400).json({ error: 'Run key: a UUID.' });
    const client = clientOf(req), slug = String(req.body?.edition ?? 'classic');
    const edition = SLUG.test(slug) && await editionOf(slug);
    if (!edition) return res.status(400).json({ error: `Unknown edition ${slug}.` });
    if (req.headers.authorization) {
      if (!isPilot(req)) return res.status(401).json({ error: 'Unknown pilot token.' });
      const pilot = String(req.body?.pilot ?? ''), model = String(req.body?.model ?? '').slice(0, 64) || null;
      if (![...PILOTS, BOT].includes(pilot)) return res.status(400).json({ error: `Pilot: one of ${[...PILOTS, BOT].join(', ')}.` });
      await recordRun({ name, pilot, model, distance, duration, client, runKey, edition: slug });
      // A model pilot's tally counts its runs; a bot's, the bot's (by name).
      const { rows: [{ number, best }] } = await db.query(
        `SELECT count(*)::int AS number, max(distance_m) AS best FROM runs WHERE pilot = $1 AND edition = $2 AND ($1 <> '${BOT}' OR name = $3)`,
        [pilot, slug, name],
      );
      const b = await boards(slug);
      return res.json({ number, best, runs: b.players, html: boardRows(b.players), boards: boardsHtml(b) });
    }
    if (!runKey) return res.status(400).json({ error: 'This page is out of date. Reload it to put runs on the board.' });
    const known = await findRun(runKey);
    if (!known) {
      const { rows: [start] } = await db.query(`SELECT (extract(epoch FROM now() - started_at) * 1000)::bigint AS elapsed_ms FROM run_starts WHERE run_key = $1`, [runKey]);
      if (!start) return res.status(400).json({ error: 'Unknown run. Fly a run to put it on the board.' });
      if (duration > Number(start.elapsed_ms) + PHYSICS.clockSlackMs) return res.status(400).json({ error: 'That run lasted longer than the time since it took off.' });
      if (!allowed(client)) return res.status(429).json({ error: 'Too many runs from here in the last minute. Try again shortly.' });
    }
    const run = known || await recordRun({ name, pilot: 'player', model: null, distance, duration, client, runKey, edition: slug });
    const { rows: [{ rank }] } = await db.query(
      `SELECT count(*)::int + 1 AS rank FROM runs WHERE edition = $3 AND pilot <> '${BOT}' AND (distance_m > $1 OR (distance_m = $1 AND created_at < $2))`,
      [run.distance_m, run.created_at, slug],
    );
    const b = await boards(slug);
    res.json({ id: run.id, rank, runs: b.players, html: boardRows(b.players), boards: boardsHtml(b) });
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
