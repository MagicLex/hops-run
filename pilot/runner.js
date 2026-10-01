// Model pilots: fly the live Hops Run page in a headless Chromium, run after run, forever. Each
// move comes from a decision model reading what the page shows (the lane, the rows ahead). The
// deciders take turns, one run each, and each finished run is posted to the game's board under
// its pilot. When the game ships a new version the page is reloaded, so the pilots always fly what
// players fly. With a stream key, the page is also streamed live (e.g. to YouTube).
//
// Settings: config.json next to this file (written by deploy.py), overridden by env:
//   GAME_URL      the game, e.g. https://game.hopsworks.ai/
//   DECIDER       the rotation, comma-separated: semif (pilot jevworks, the default), jev (pilot jev),
//                 kumo (pilot kumo), clef (pilot clef); e.g. semif,kumo,jev
//   SEMIF_URL     path-routed predict URL of the semif deployment, for semif
//   KUMO_URL      path-routed predict URL of the Kumo Tabular deployment (MagicLex/jevworks kumo/), for kumo
//   CLEF_URL      path-routed predict URL of the Clef-Flash deployment (MagicLex/jevworks clef/), for clef
//   JEV_URL       TypeSafe System One endpoint, e.g. https://api.typesafe.ai/v1/systemone, for jev
//   JEV_MODEL     TypeSafe model, e.g. jev-latest, for jev
//   TYPESAFE_API_KEY  TypeSafe API key, for jev
//   VIEWPORT      page size, e.g. 1920x1080
//   GPU           "true": render on the pod's GPU (Vulkan); otherwise SwiftShader on the CPU
//   PILOT_TOKEN   bearer token the game accepts pilot runs with (start.sh reads it from a secret)
//   STREAM_URL    RTMP(S) ingest URL, e.g. rtmps://a.rtmp.youtube.com/live2
//   STREAM_KEY    stream key (start.sh reads it from a secret); no stream when unset
//   STREAM_CHANNEL  YouTube channel id the key streams to: while it shows no live video, the
//                 ingest is reconnected (see createStream)
//   FFMPEG        ffmpeg binary with NVENC (start.sh downloads one)
//   APP_PORT      health port, set by Hopsworks
//   HOPSWORKS_API_KEY  API key with the SERVING scope, for runs outside Hopsworks; inside an App
//                      the pod's own JWT (SECRETS_DIR/token.jwt) authenticates to semif

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const file = new URL('config.json', import.meta.url);
const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const cfg = {
  gameUrl: process.env.GAME_URL ?? stored.gameUrl,
  decider: process.env.DECIDER ?? stored.decider ?? 'semif',
  semifUrl: process.env.SEMIF_URL ?? stored.semifUrl,
  kumoUrl: process.env.KUMO_URL ?? stored.kumoUrl,
  clefUrl: process.env.CLEF_URL ?? stored.clefUrl,
  jevUrl: process.env.JEV_URL ?? stored.jevUrl,
  jevModel: process.env.JEV_MODEL ?? stored.jevModel,
  jevKey: process.env.TYPESAFE_API_KEY,
  viewport: process.env.VIEWPORT ?? stored.viewport,
  gpu: String(process.env.GPU ?? stored.gpu) === 'true',
  token: process.env.PILOT_TOKEN,
  streamUrl: process.env.STREAM_URL ?? stored.streamUrl,
  streamKey: process.env.STREAM_KEY,
  streamChannel: process.env.STREAM_CHANNEL ?? stored.streamChannel,
  ffmpeg: process.env.FFMPEG,
  port: Number(process.env.APP_PORT ?? process.env.PORT),
  apiKey: process.env.HOPSWORKS_API_KEY,
  jwt: process.env.SECRETS_DIR && `${process.env.SECRETS_DIR}/token.jwt`,
};
const DECIDERS = {
  semif: { pilot: 'jevworks', needs: ['semifUrl'] },
  jev: { pilot: 'jev', needs: ['jevUrl', 'jevModel', 'jevKey'] },
  kumo: { pilot: 'kumo', needs: ['kumoUrl'] },
  clef: { pilot: 'clef', needs: ['clefUrl'] },
};
const ROTATION = cfg.decider.split(',').map((d) => d.trim());
if (ROTATION.some((d) => !DECIDERS[d])) throw new Error(`DECIDER: comma-separated, of ${Object.keys(DECIDERS).join(', ')}`);
const missing = [...new Set(['gameUrl', 'viewport', 'token', 'port', ...ROTATION.flatMap((d) => DECIDERS[d].needs)])].filter((k) => !cfg[k]);
if (ROTATION.some((d) => ['semif', 'kumo', 'clef'].includes(d)) && !cfg.apiKey && !cfg.jwt) missing.push('HOPSWORKS_API_KEY or SECRETS_DIR');
if (cfg.streamKey && (!cfg.streamUrl || !cfg.ffmpeg)) missing.push('STREAM_URL and FFMPEG, for STREAM_KEY');
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

// The decider flying the current run; the next run is the next decider's.
let turn = 0;
const flying = () => ROTATION[turn % ROTATION.length];
// Per pilot: runs, best and last distance as the board counts them, and the model it flies with.
const stats = { pilots: {}, version: null, renderer: null, stream: cfg.streamKey ? 'starting' : 'off', streamRestarts: 0, lastDecision: Date.now() };

// A Hopsworks deployment answers with option ids, probabilities and its forward time: semif reads
// the decision as text (row), Kumo Tabular as the game state itself.
async function decideServed(name, url, input) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: [input] }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const [p] = JSON.parse(text).predictions;
  return { moves: p.option_ids, probabilities: p.probabilities, forwardMs: p.forward_seconds * 1000, model: String(p.model.revision ?? '').replace(/^hopsworks:/, '') };
}

// Jev and Clef answer the same decision as one SystemOne Choice question: the options are the
// criteria. Jev is TypeSafe's API; Clef is a Hopsworks deployment (MagicLex/jevworks clef/) answering the same
// request body, with its forward time. Jev reports none, so its round trip stands in.
function choiceRequest(state, model) {
  const { state: text, question, options } = row(state);
  return { moves: options.map((o) => o.id), body: { model, state: text, questions: { move: { type: 'choice', instructions: question, criteria: Object.fromEntries(options.map((o) => [o.id, o.description])) } } } };
}
async function decideJev(state) {
  const { moves, body: request } = choiceRequest(state, cfg.jevModel), t0 = performance.now();
  const res = await fetch(cfg.jevUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.jevKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`jev: HTTP ${res.status} ${body.slice(0, 200)}`);
  const d = JSON.parse(body);
  return { moves, probabilities: moves.map((m) => d.answers.move.probabilities[m] ?? 0), forwardMs: performance.now() - t0, model: d.model };
}
async function decideClef(state) {
  const { moves, body: request } = choiceRequest(state, 'clef-flash');
  const res = await fetch(cfg.clefUrl, {
    method: 'POST',
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: [request] }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`clef: HTTP ${res.status} ${body.slice(0, 200)}`);
  const [d] = JSON.parse(body).predictions;
  return { moves, probabilities: moves.map((m) => d.answers.move.probabilities[m] ?? 0), forwardMs: d.forward_seconds * 1000, model: String(d.model ?? '').replace(/^hopsworks:/, '') };
}
const DECIDE = {
  semif: (state) => decideServed('semif', cfg.semifUrl, row(state)),
  kumo: (state) => decideServed('kumo', cfg.kumoUrl, state),
  jev: decideJev,
  clef: decideClef,
};
const pilotStats = (pilot) => (stats.pilots[pilot] ??= { runs: 0, best: 0, last: null, model: null });
async function decide(state) {
  const decider = flying(), d = await DECIDE[decider](state), pilot = DECIDERS[decider].pilot;
  stats.lastDecision = Date.now();
  pilotStats(pilot).model = d.model;
  return { pilot, ...d };
}

// --- runs ----------------------------------------------------------------------------------------
const gameVersion = async () => (await (await fetch(new URL('health', cfg.gameUrl), { signal: AbortSignal.timeout(5000) })).json()).version;
let reloadPending = false;

async function finished(run) {
  const pilot = DECIDERS[flying()].pilot, mine = pilotStats(pilot);
  turn++; // posted or not, the next run is the next decider's
  const res = await fetch(new URL('api/runs', cfg.gameUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: pilot, pilot, model: mine.model, ...run }),
    signal: AbortSignal.timeout(10_000),
  });
  const d = await res.json().catch(() => ({ error: `game: HTTP ${res.status}` }));
  if (!res.ok || d.error) {
    console.error(`${pilot} run not posted: ${d.error}`);
    return { error: d.error ?? `game: HTTP ${res.status}` };
  }
  Object.assign(mine, { runs: d.number, best: d.best, last: run.distance });
  console.log(`${pilot} run ${d.number}: ${run.distance} m in ${(run.durationMs / 1000).toFixed(1)} s, best ${d.best} m`);
  // A new game version reaches the pilot between runs.
  reloadPending = (await gameVersion().catch(() => stats.version)) !== stats.version;
  return d;
}

// --- stream --------------------------------------------------------------------------------------
// The page as video: Chromium's screencast (JPEG frames as they are painted) into ffmpeg, encoded
// on the GPU (NVENC) at a constant 30 fps with a silent audio track (YouTube expects one), pushed
// to STREAM_URL. One ffmpeg lives as long as the runner, so the ingest never drops: the screencast
// moves to each new page (a reload, a relaunched browser), and between pages the last frame is
// sent again. A dead ffmpeg is restarted; frames are dropped while it lags rather than buffered.
// ffmpeg's messages are logged with the key redacted.
// YouTube binds an ingest to the broadcast open when it connects: one that connects while YouTube
// is still closing the previous broadcast (after a long drop) stays bound to it and never goes
// live. With STREAM_CHANNEL, the channel's public live page is checked every minute; off air for
// offAirChecks checks in a row while ffmpeg runs, the ingest is reconnected, at most every
// reconnectMs.
const STREAM = { fps: 30, bitrate: '6M', backlogBytes: 8 << 20, holdMs: 100, checkMs: 60_000, offAirChecks: 3, reconnectMs: 10 * 60_000 };
const onAir = async () => {
  const res = await fetch(`https://www.youtube.com/channel/${cfg.streamChannel}/live`, { headers: { 'Accept-Language': 'en', Cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(15_000) });
  return /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=/.test(await res.text());
};
function createStream() {
  let ff = null, cdp = null, last = null, lastAt = 0, stopped = false;
  const redact = (text) => String(text).replaceAll(cfg.streamKey, '***');
  const write = (frame) => { if (ff?.stdin.writable && ff.stdin.writableLength < STREAM.backlogBytes) ff.stdin.write(frame); };
  const start = () => {
    if (stopped) return;
    ff = spawn(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'warning',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-map', '0:v', '-map', '1:a',
      '-vf', `fps=${STREAM.fps},scale=in_range=pc:out_range=tv,format=yuv420p`, '-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', STREAM.bitrate,
      '-maxrate', STREAM.bitrate, '-bufsize', `${parseInt(STREAM.bitrate, 10) * 2}M`, '-g', String(STREAM.fps * 2),
      '-c:a', 'aac', '-b:a', '128k', '-f', 'flv', `${cfg.streamUrl}/${cfg.streamKey}`], { stdio: ['pipe', 'ignore', 'pipe'] });
    ff.stdin.on('error', () => {}); // a dying ffmpeg closes its input; the exit handler restarts it
    ff.stderr.on('data', (d) => console.error(`ffmpeg: ${redact(d).trim()}`));
    ff.on('spawn', () => { stats.stream = 'live'; });
    ff.on('exit', (code) => {
      if (stopped) return;
      stats.stream = 'restarting'; stats.streamRestarts++;
      console.error(`stream: ffmpeg exited with ${code}, restarting`);
      setTimeout(start, 5000);
    });
  };
  start();
  const hold = setInterval(() => { if (last && Date.now() - lastAt > STREAM.holdMs) write(last); }, STREAM.holdMs);
  let offAir = 0, reconnectedAt = 0;
  const watch = cfg.streamChannel && setInterval(async () => {
    const live = await onAir().catch(() => null); // unreachable: no verdict
    if (live === null) return;
    stats.youtube = live ? 'live' : 'off air';
    offAir = live ? 0 : offAir + 1;
    if (offAir >= STREAM.offAirChecks && ff?.exitCode === null && Date.now() - reconnectedAt > STREAM.reconnectMs) {
      console.error(`stream: channel off air for ${offAir} checks, reconnecting the ingest`);
      offAir = 0; reconnectedAt = Date.now();
      ff.kill('SIGKILL'); // the exit handler starts a new ffmpeg
    }
  }, STREAM.checkMs);
  return {
    // Feed the stream from this page from now on.
    async attach(page) {
      await cdp?.detach().catch(() => {});
      cdp = await page.context().newCDPSession(page);
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        last = Buffer.from(data, 'base64'); lastAt = Date.now();
        write(last);
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: width, maxHeight: height });
    },
    // The runner exits: ffmpeg is killed at once (on SIGTERM it would flush its output and can
    // block there on the network, holding the ingest).
    stop() {
      stopped = true; stats.stream = 'off';
      clearInterval(hold); clearInterval(watch);
      if (ff && ff.exitCode === null) ff.kill('SIGKILL');
    },
  };
}
const stream = cfg.streamKey ? createStream() : null;

// --- browser -------------------------------------------------------------------------------------
let current = null; // the page being flown, for /frame.jpg
async function fly() {
  const args = cfg.gpu
    ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args });
  try {
    const page = current = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
    await page.addInitScript(() => { try { localStorage.setItem('umami.disabled', '1'); } catch { /* storage blocked */ } });
    await page.exposeFunction('jevworksDecide', decide);
    await page.exposeFunction('jevworksFinished', finished);
    const closed = new Promise((resolve) => { page.on('crash', resolve); page.on('close', resolve); browser.on('disconnected', resolve); });
    for (;;) {
      stats.version = await gameVersion();
      await page.goto(cfg.gameUrl);
      stats.lastDecision = Date.now();
      stats.renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info');
        return gl ? gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'no WebGL';
      });
      console.log(`flying ${cfg.gameUrl} v${stats.version}, ${cfg.viewport} on ${stats.renderer}`);
      await stream?.attach(page).catch((e) => console.error(`stream: ${e.message}`));
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

// GET /frame.jpg: what the page shows right now. Anything else: the pilot's state as JSON.
createServer(async (req, res) => {
  if (req.url === '/frame.jpg') {
    const frame = await current?.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
    res.writeHead(frame ? 200 : 503, { 'Content-Type': frame ? 'image/jpeg' : 'text/plain' });
    return res.end(frame ?? 'no page');
  }
  const ok = req.url === '/health' && Date.now() - stats.lastDecision < WATCHDOG_MS;
  res.writeHead(ok || req.url !== '/health' ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: ok ? 'ok' : 'stalled', flying: DECIDERS[flying()].pilot, ...stats, lastDecision: new Date(stats.lastDecision).toISOString() }));
}).listen(cfg.port, '0.0.0.0', () => console.log(`pilots ${ROTATION.join(', ')} health on :${cfg.port}`));

// A stop (SIGTERM, SIGINT) ends the pilot: Playwright closes the browser on these signals, and the
// loop below would otherwise take that for a lost browser and relaunch it.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { console.log(`${signal}: stopping`); stream?.stop(); process.exit(0); });
}

// Run for ever: a lost page or browser is relaunched after a pause.
for (;;) {
  try { await fly(); } catch (e) { console.error(`relaunching: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 10_000));
}
