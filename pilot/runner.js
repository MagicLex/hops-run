// jevworks pilot: flies the live Hops Run page in a headless Chromium, run after run, forever.
// Each move comes from the semif deployment of this Hopsworks project, read from what the page
// shows (the lane, the rows ahead); each finished run is posted to the game's board as the
// jevworks pilot. When the game ships a new version the page is reloaded, so the pilot always
// flies what players fly.
//
// Settings: config.json next to this file (written by deploy.py), overridden by env:
//   GAME_URL      the game, e.g. https://game.hopsworks.ai/
//   SEMIF_URL     path-routed predict URL of the semif deployment
//   VIEWPORT      page size, e.g. 1920x1080
//   GPU           "true": render on the pod's GPU (Vulkan); otherwise SwiftShader on the CPU
//   PILOT_TOKEN   bearer token the game accepts pilot runs with (start.sh reads it from a secret)
//   APP_PORT      health port, set by Hopsworks
//   HOPSWORKS_API_KEY  API key with the SERVING scope, for runs outside Hopsworks; inside an App
//                      the pod's own JWT (SECRETS_DIR/token.jwt) authenticates to semif

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const file = new URL('config.json', import.meta.url);
const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const cfg = {
  gameUrl: process.env.GAME_URL ?? stored.gameUrl,
  semifUrl: process.env.SEMIF_URL ?? stored.semifUrl,
  viewport: process.env.VIEWPORT ?? stored.viewport,
  gpu: String(process.env.GPU ?? stored.gpu) === 'true',
  token: process.env.PILOT_TOKEN,
  port: Number(process.env.APP_PORT ?? process.env.PORT),
  apiKey: process.env.HOPSWORKS_API_KEY,
  jwt: process.env.SECRETS_DIR && `${process.env.SECRETS_DIR}/token.jwt`,
};
const missing = ['gameUrl', 'semifUrl', 'viewport', 'token', 'port'].filter((k) => !cfg[k]);
if (!cfg.apiKey && !cfg.jwt) missing.push('HOPSWORKS_API_KEY or SECRETS_DIR');
if (missing.length) throw new Error(`missing setting: ${missing.join(', ')}`);
const [width, height] = cfg.viewport.split('x').map(Number);
// The platform rotates the pod's JWT: read it per call.
const auth = () => (cfg.apiKey ? `ApiKey ${cfg.apiKey}` : `Bearer ${readFileSync(cfg.jwt, 'utf8').trim()}`);
const WATCHDOG_MS = 5 * 60_000; // no decision for this long: the browser is relaunched

// --- decisions -----------------------------------------------------------------------------------
// The prompt is the one measured with eval/decide.py on the jev-pilot tag: the facts sit in the
// options (what each move leads into), so the model judges each move's consequence.
const LANES = ['left', 'centre', 'right'];
const HAS = { wall: 'a wall', low: 'a low block', bar: 'a bar', undefined: 'nothing, it is open' };
const RULES = 'The hops crashes if it hits a wall: jumping or ducking never clears a wall, only moving to another lane does. Jumping clears a low block or a bar. Ducking clears a bar. Flying straight is only safe in an open lane.';
function row({ lane, airborne, ahead }) {
  const next = ahead[0], i = LANES.indexOf(lane), lanes = next?.lanes ?? {}, here = HAS[lanes[lane]];
  const options = [];
  for (const [id, j] of [['left', i - 1], ['right', i + 1]]) {
    if (j >= 0 && j < 3) options.push({ id, description: `Move to the ${LANES[j]} lane, which has ${HAS[lanes[LANES[j]]]}` });
  }
  options.push({ id: 'hold', description: `Stay in the ${lane} lane, which has ${here}, and fly straight` });
  if (!airborne) options.push({ id: 'up', description: `Stay in the ${lane} lane, which has ${here}, and jump` });
  options.push({ id: 'down', description: `Stay in the ${lane} lane, which has ${here}, and duck` });
  const where = next ? `The next row of obstacles is ${Math.round(next.distance)} m ahead.` : 'There are no obstacles ahead.';
  return { id: 'hops', state: `${RULES} The hops is in the ${lane} lane${airborne ? ', in the air' : ''}. ${where}`, question: 'What should the hops do?', options };
}

const stats = { runs: 0, best: 0, last: null, model: null, version: null, lastDecision: Date.now() };

async function decide(state) {
  const res = await fetch(cfg.semifUrl, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: [row(state)] }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`semif: HTTP ${res.status} ${text.slice(0, 200)}`);
  const [p] = JSON.parse(text).predictions;
  stats.lastDecision = Date.now();
  stats.model = String(p.model.revision ?? '').replace(/^hopsworks:/, '');
  return { moves: p.option_ids, probabilities: p.probabilities, forwardMs: p.forward_seconds * 1000, model: stats.model };
}

// --- runs ----------------------------------------------------------------------------------------
const gameVersion = async () => (await (await fetch(new URL('health', cfg.gameUrl), { signal: AbortSignal.timeout(5000) })).json()).version;
let reloadPending = false;

async function finished(run) {
  const res = await fetch(new URL('api/runs', cfg.gameUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'jevworks', pilot: 'jevworks', model: stats.model, ...run }),
    signal: AbortSignal.timeout(10_000),
  });
  const d = await res.json().catch(() => ({ error: `game: HTTP ${res.status}` }));
  if (!res.ok || d.error) {
    console.error(`run not posted: ${d.error}`);
    return { error: d.error ?? `game: HTTP ${res.status}` };
  }
  Object.assign(stats, { runs: d.number, best: d.best, last: run.distance });
  console.log(`run ${d.number}: ${run.distance} m in ${(run.durationMs / 1000).toFixed(1)} s, best ${d.best} m`);
  // A new game version reaches the pilot between runs.
  reloadPending = (await gameVersion().catch(() => stats.version)) !== stats.version;
  return d;
}

// --- browser -------------------------------------------------------------------------------------
async function fly() {
  const args = cfg.gpu
    ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
    await page.addInitScript(() => { try { localStorage.setItem('umami.disabled', '1'); } catch { /* storage blocked */ } });
    await page.exposeFunction('jevworksDecide', decide);
    await page.exposeFunction('jevworksFinished', finished);
    const closed = new Promise((resolve) => { page.on('crash', resolve); page.on('close', resolve); browser.on('disconnected', resolve); });
    for (;;) {
      stats.version = await gameVersion();
      await page.goto(cfg.gameUrl);
      stats.lastDecision = Date.now();
      console.log(`flying ${cfg.gameUrl} v${stats.version}, ${cfg.gpu ? 'GPU' : 'CPU'} ${cfg.viewport}`);
      reloadPending = false;
      while (!reloadPending) {
        const outcome = await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(r, 5000, 'tick'))]);
        if (outcome === 'closed') throw new Error('page or browser gone');
        if (Date.now() - stats.lastDecision > WATCHDOG_MS) throw new Error(`no decision for ${WATCHDOG_MS / 1000} s`);
      }
      // Leave the crash screen up for its pause before the new version takes over.
      await page.waitForTimeout(3000);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

createServer((req, res) => {
  const ok = req.url === '/health' && Date.now() - stats.lastDecision < WATCHDOG_MS;
  res.writeHead(ok || req.url !== '/health' ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: ok ? 'ok' : 'stalled', ...stats, lastDecision: new Date(stats.lastDecision).toISOString() }));
}).listen(cfg.port, '0.0.0.0', () => console.log(`jevworks pilot health on :${cfg.port}`));

// Run for ever: a lost page or browser is relaunched after a pause.
for (;;) {
  try { await fly(); } catch (e) { console.error(`relaunching: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 10_000));
}
