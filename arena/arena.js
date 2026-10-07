// Arena: pilots fly Hops Run headless on the game's own simulation (game/public/sim.js), each over
// the same seeds, so every pilot meets the same tracks.
//
//   node arena/arena.js --pilots claude-bot,claude-fable-bot,kumo [--edition odd | --maker <name>] [--runs 30] [--seed 1] [--max 100000] [--json]
//
// The track is an edition: `classic` (the game's own) or arena/editions/<name>.json. Or a track
// maker proposes the rows: arena/makers/<name>.js, exporting the maker as default and, optionally,
// `kinds` and `zones` of its own. sim.js checks editions, kinds and zones against its bounds, and
// every row against the witness.
//
// A pilot is a bot (bots/<name>/pilot.js, run in a sandbox whose clock is the run's own) or a
// model decider (semif, kumo, jev, clef), with the settings pilot/runner.js reads: SEMIF_URL,
// KUMO_URL, CLEF_URL, JEV_URL, JEV_MODEL, TYPESAFE_API_KEY, HOPSWORKS_API_KEY. A pilot is asked as
// the page asks it: whenever no answer is pending, at most once per 60 Hz frame. An answer lands
// once its round trip has passed in run time, so a slow pilot flies blind as long as on the page.
// A run ends at its crash, or at --max metres.

import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { createRun, CLASSIC, DT } from '../game/public/sim.js';
import { DECIDERS, createDeciders } from '../pilot/deciders.js';

const { values: args } = parseArgs({
  options: {
    pilots: { type: 'string' },
    edition: { type: 'string', default: 'classic' },
    maker: { type: 'string' },
    runs: { type: 'string', default: '30' },
    seed: { type: 'string', default: '1' },
    max: { type: 'string', default: '100000' },
    json: { type: 'boolean', default: false },
  },
});
if (!args.pilots) throw new Error('--pilots: comma-separated bots (bots/<name>) and deciders (semif, kumo, jev, clef)');
const RUNS = Number(args.runs), SEED = Number(args.seed), MAX = Number(args.max);
const FRAME = Math.round(1 / 60 / DT); // steps per 60 Hz frame
const BETWEEN_RUNS_MS = 5000; // a bot's clock moves on this much between runs, as on the page

// What the runs fly: { edition, maker }, as createRun takes them.
async function loadTrack({ edition, maker }) {
  const file = (dir, name, ext) => {
    if (!/^[\w-]+$/.test(name)) throw new Error(`${name}: a name from arena/${dir}/`);
    const url = new URL(`${dir}/${name}.${ext}`, import.meta.url);
    if (!existsSync(url)) throw new Error(`no arena/${dir}/${name}.${ext}`);
    return url;
  };
  if (maker) {
    const m = await import(file('makers', maker, 'js'));
    return { label: `maker ${maker}`, edition: { ...CLASSIC, name: maker, kinds: m.kinds, zones: m.zones }, maker: m.default };
  }
  if (edition === 'classic') return { label: 'edition classic', edition: CLASSIC };
  return { label: `edition ${edition}`, edition: JSON.parse(readFileSync(file('editions', edition, 'json'), 'utf8')) };
}
const TRACK = await loadTrack(args);

// A bot is the browser script it is on the page, run in its own context with the run's clock.
function loadBot(name) {
  const file = new URL(`../bots/${name}/pilot.js`, import.meta.url);
  if (!existsSync(file)) return null;
  const clock = { ms: 0 };
  const context = vm.createContext({ performance: { now: () => clock.ms }, console });
  context.window = context;
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file.pathname });
  return { name, clock, decide: (view) => context.hopsRunDecide(view) };
}

const DECIDE = createDeciders({
  semifUrl: process.env.SEMIF_URL, kumoUrl: process.env.KUMO_URL, clefUrl: process.env.CLEF_URL,
  jevUrl: process.env.JEV_URL, jevModel: process.env.JEV_MODEL, jevKey: process.env.TYPESAFE_API_KEY,
  apiKey: process.env.HOPSWORKS_API_KEY,
});
const ENV = { semifUrl: 'SEMIF_URL', kumoUrl: 'KUMO_URL', clefUrl: 'CLEF_URL', jevUrl: 'JEV_URL', jevModel: 'JEV_MODEL', jevKey: 'TYPESAFE_API_KEY' };
function loadPilot(name) {
  const bot = loadBot(name);
  if (bot) return bot;
  const decider = DECIDERS[name];
  if (!decider) throw new Error(`${name}: neither bots/${name}/pilot.js nor a decider (${Object.keys(DECIDERS).join(', ')})`);
  const missing = decider.needs.map((k) => ENV[k]).filter((k) => !process.env[k]);
  if (decider.hopsworks && !process.env.HOPSWORKS_API_KEY) missing.push('HOPSWORKS_API_KEY');
  if (missing.length) throw new Error(`${name}: missing ${missing.join(', ')}`);
  return { name: decider.pilot, decide: DECIDE[name] };
}

async function fly(pilot, seed) {
  const run = createRun({ seed, edition: TRACK.edition, maker: TRACK.maker }), base = pilot.clock?.ms ?? 0;
  let pending = null, step = 0;
  while (!run.crash && run.distance < MAX) {
    if (!pending && step % FRAME === 0) {
      if (pilot.clock) pilot.clock.ms = base + run.flightMs;
      const started = performance.now(), d = await pilot.decide(run.view());
      const choice = d.moves[d.probabilities.indexOf(Math.max(...d.probabilities))];
      pending = { at: step + Math.max(1, Math.ceil((performance.now() - started) / 1000 / DT)), choice };
    }
    run.tick(); step++;
    if (pending && step >= pending.at) { run.decide(pending.choice); pending = null; }
  }
  if (pilot.clock) pilot.clock.ms = base + run.flightMs + BETWEEN_RUNS_MS;
  // What ended the run: the kind of the part hit, or the rule failed.
  const cause = run.crash && (run.crash.rule ? `${run.crash.rule} rule` : run.crash.row.parts[run.crash.part].kind);
  return { seed, distance: Math.round(run.distance), cause, capped: !run.crash, redrawn: run.redrawn, pushed: run.pushed };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const results = [];
for (const name of args.pilots.split(',').map((p) => p.trim())) {
  const pilot = loadPilot(name), runs = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(await fly(pilot, SEED + i));
    if (!args.json) process.stderr.write(`\r${name}: ${i + 1}/${RUNS}`);
  }
  const d = runs.map((r) => r.distance).sort((a, b) => a - b);
  results.push({
    pilot: name, runs,
    median: quantile(d, 0.5), mean: Math.round(d.reduce((a, b) => a + b, 0) / d.length), p90: quantile(d, 0.9), best: d.at(-1),
    capped: runs.filter((r) => r.capped).length,
    causes: Object.fromEntries(Object.entries(runs.reduce((n, r) => (r.cause ? { ...n, [r.cause]: (n[r.cause] ?? 0) + 1 } : n), {})).sort((a, b) => b[1] - a[1])),
  });
  if (!args.json) process.stderr.write('\n');
}

if (args.json) console.log(JSON.stringify({ track: TRACK.label, seeds: [SEED, SEED + RUNS - 1], max: MAX, results }, null, 2));
else {
  console.log(`${TRACK.label}, seeds ${SEED} to ${SEED + RUNS - 1}${results.some((r) => r.capped) ? `, runs capped at ${MAX} m` : ''}`);
  console.log(['pilot', 'median', 'mean', 'p90', 'best', 'capped'].map((h) => h.padStart(h === 'pilot' ? 18 : 8)).join('') + '   crashed on');
  for (const r of results) console.log(r.pilot.padStart(18) + [r.median, r.mean, r.p90, r.best, r.capped].map((v) => String(v).padStart(8)).join('') + '   ' + Object.entries(r.causes).map(([c, n]) => `${c} ${n}`).join(', '));
}
