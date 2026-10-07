// Designer: a new edition of Hops Run every day. It draws candidate editions within the game's
// bounds, flies every bot in bots/ on each in the arena, keeps those whose bots' median falls in
// the band (neither trivial nor brutal), and asks SemIf on Qwen (the qwen pilot's deployment)
// which one the game plays today, told what each holds, how the bots fared on it, and how
// yesterday's edition went. The pick is published to the game (POST /api/editions), live at once,
// and the bots' runs on it go to the bots' board. Runs as a Hopsworks App: at start when today has
// no edition, then every day at 00:05 UTC; GET /health answers what it did last.
//
// Settings: config.json next to this file (written by deploy.py), overridden by env:
//   GAME_URL     the game, e.g. https://game.hopsworks.ai/
//   SEMIF_URL    path-routed predict URL of the semif deployment
//   PILOT_TOKEN  bearer token the game takes editions and bots' runs with (start.sh reads it)
//   CANDIDATES   candidate editions drawn a day (default 8)
//   SEEDS        seeds each bot flies a candidate on (default 10)
//   BAND         the bots' median a candidate must fall in, metres (default 600-4000)
//   APP_PORT     health port, set by Hopsworks
//   HOPSWORKS_API_KEY  API key with the SERVING scope, outside Hopsworks; inside an App the pod's
//                      own JWT (SECRETS_DIR/token.jwt) authenticates to semif

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { KINDS, ZONES, RULES, stream } from '../game/public/sim.js';
import { bots, loadPilot, fly, summary } from '../arena/lib.js';
import { createDeciders } from '../pilot/deciders.js';

const file = new URL('config.json', import.meta.url);
const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const cfg = {
  gameUrl: process.env.GAME_URL ?? stored.gameUrl,
  semifUrl: process.env.SEMIF_URL ?? stored.semifUrl,
  token: process.env.PILOT_TOKEN,
  candidates: Number(process.env.CANDIDATES ?? stored.candidates ?? 8),
  seeds: Number(process.env.SEEDS ?? stored.seeds ?? 10),
  band: String(process.env.BAND ?? stored.band ?? '600-4000').split('-').map(Number),
  port: Number(process.env.APP_PORT ?? process.env.PORT),
  apiKey: process.env.HOPSWORKS_API_KEY,
  jwt: process.env.SECRETS_DIR && `${process.env.SECRETS_DIR}/token.jwt`,
};
const missing = ['gameUrl', 'semifUrl', 'token', 'port'].filter((k) => !cfg[k]);
if (!cfg.apiKey && !cfg.jwt) missing.push('HOPSWORKS_API_KEY or SECRETS_DIR');
if (!(cfg.band.length === 2 && cfg.band[0] < cfg.band[1])) missing.push('BAND as min-max metres');
if (missing.length) throw new Error(`missing setting: ${missing.join(', ')}`);
const semif = createDeciders(cfg);
const DESIGN = { maxM: 20_000, retryMs: 30 * 60_000, atUtc: [0, 5] };

// --- candidates ----------------------------------------------------------------------------------
// Drawn from the day's seed: walls always, the other kinds by chance and weight, a share of
// two-lane rows, zones and rules by chance, the gap range. Each is described in plain words, for
// the pilots and for SemIf.
const PLURAL = { wall: 'walls', low: 'low blocks', bar: 'bars', sweeper: 'sliding walls', dropbar: 'falling bars' };
const round = (x) => Math.round(x * 100) / 100;
const oneIn = (p) => `1 row in ${Math.max(2, Math.round(1 / p))}`;
const list = (names) => names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
function describe(e) {
  const total = Object.values(e.mix).reduce((a, w) => a + w, 0);
  const kinds = Object.entries(e.mix).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([k, w]) => `${PLURAL[k] ?? k} ${Math.round((100 * w) / total)}%`);
  const parts = [`${kinds.join(', ')}`, `two lanes taken in ${Math.round(e.two * 100)}% of rows`];
  if (e.zone) parts.push(`${list(Object.keys(e.zone.mix))} zones on ${oneIn(e.zone.p)}`);
  if (e.rule) parts.push(`a ${list(Object.keys(e.rule.mix))} rule on ${oneIn(e.rule.p)}`);
  parts.push(`rows ${e.gap[0]} to ${e.gap[1]} m apart`);
  const text = `${parts.join('; ')}.`;
  return text[0].toUpperCase() + text.slice(1);
}
function draw(rng) {
  const subset = (names) => {
    const picked = names.filter(() => rng() < 0.5);
    return Object.fromEntries((picked.length ? picked : [names[Math.floor(rng() * names.length)]]).map((n) => [n, 1]));
  };
  const e = { mix: { wall: round(0.2 + rng() * 0.5) }, two: round(0.2 + rng() * 0.4) };
  for (const k of Object.keys(KINDS)) if (k !== 'wall' && rng() < 0.6) e.mix[k] = round(0.05 + rng() * 0.95);
  if (rng() < 0.6) e.zone = { p: round(0.05 + rng() * 0.25), mix: subset(Object.keys(ZONES)) };
  if (rng() < 0.5) e.rule = { p: round(0.05 + rng() * 0.15), mix: subset(Object.keys(RULES)) };
  const lo = Math.round(36 + rng() * 14);
  e.gap = [lo, lo + Math.round(20 + rng() * 15)];
  e.describe = describe(e);
  return e;
}
const hash = (text) => [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) | 0;

// --- the arena's gate ----------------------------------------------------------------------------
// Every bot over the day's seeds: the runs, their summary.
async function gate(edition, seed) {
  const runs = [];
  for (const name of bots()) {
    const pilot = loadPilot(name);
    for (let i = 0; i < cfg.seeds; i++) runs.push({ bot: name, ...(await fly(pilot, seed + i, { edition }, DESIGN.maxM)) });
  }
  return { runs, ...summary(runs) };
}

// --- the game ------------------------------------------------------------------------------------
async function game(path, body) {
  const res = await fetch(new URL(path, cfg.gameUrl), {
    method: body ? 'POST' : 'GET',
    headers: body ? { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' } : {},
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { status: res.status, ...d };
}

// --- a day ---------------------------------------------------------------------------------------
async function design(slug) {
  const { editions } = await game('api/editions');
  if (editions.some((e) => e.slug === slug)) return { slug, already: true };
  const yesterday = editions.find((e) => e.slug !== 'classic');
  const rng = stream(hash(slug), 7), seed = hash(slug) >>> 8;
  const candidates = [];
  for (let i = 0; i < cfg.candidates; i++) {
    const edition = { name: `candidate-${i + 1}`, ...draw(rng) };
    candidates.push({ edition, ...(await gate(edition, seed)) });
    console.log(`${slug} candidate ${i + 1}: bots' median ${candidates.at(-1).median} m, ${edition.describe}`);
  }
  // In the band; else the three nearest it.
  const [lo, hi] = cfg.band, off = (c) => Math.max(0, lo - c.median, c.median - hi);
  let pool = candidates.filter((c) => off(c) === 0);
  if (!pool.length) pool = [...candidates].sort((a, b) => off(a) - off(b)).slice(0, 3);
  const before = yesterday
    ? `Yesterday's edition, ${yesterday.slug}: ${yesterday.spec?.describe ?? ''} It was flown ${yesterday.runs} times, and the best run was ${yesterday.best} m.`
    : 'This is the first edition.';
  const d = await semif.ask({
    id: 'edition',
    state: `Hops Run is a racing game whose track changes every day. Players and AI pilots fly the day's edition. A good edition feels new, is hard, and stays fair. ${before}`,
    question: 'Which edition should Hops Run play today?',
    options: pool.map((c, i) => ({ id: `c${i + 1}`, description: `${c.edition.describe} The bots fly a median ${c.median} m on it.` })),
  });
  const pick = d.moves[d.probabilities.indexOf(Math.max(...d.probabilities))], chosen = pool[Number(pick.slice(1)) - 1];
  const { name: _candidate, ...spec } = chosen.edition;
  const published = await game('api/editions', { slug, designer: `qwen · ${d.model}`, spec });
  if (published.status !== 201) throw new Error(`publishing ${slug}: ${published.error}`);
  for (const r of chosen.runs) {
    const posted = await game('api/runs', { name: r.bot, pilot: 'bot', model: r.model ?? r.bot, distance: r.distance, durationMs: Math.max(1, r.durationMs), runKey: randomUUID(), edition: slug });
    if (posted.error) console.error(`${slug}: ${r.bot} run not posted: ${posted.error}`);
  }
  console.log(`${slug} published: ${spec.describe} (bots' median ${chosen.median} m, chosen by ${d.model})`);
  return { slug, describe: spec.describe, median: chosen.median, designer: d.model };
}

const status = { state: 'starting', last: null, error: null, next: null };
function nextRun(now = new Date()) {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), ...DESIGN.atUtc));
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}
async function cycle() {
  status.state = 'designing';
  try {
    status.last = { ...(await design(new Date().toISOString().slice(0, 10))), at: new Date().toISOString() };
    status.error = null;
    status.next = nextRun();
  } catch (e) {
    console.error(`design failed: ${e.message}`);
    status.error = e.message;
    status.next = new Date(Date.now() + DESIGN.retryMs);
  }
  status.state = 'waiting';
  setTimeout(cycle, status.next - Date.now());
}

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...status, bots: bots(), band: cfg.band }));
}).listen(cfg.port, '0.0.0.0', () => console.log(`designer health on :${cfg.port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
cycle();
