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
// Pilots are bots from bots/ and deciders (semif, kumo, jev, clef) with the settings
// pilot/runner.js reads: SEMIF_URL, KUMO_URL, CLEF_URL, JEV_URL, JEV_MODEL, TYPESAFE_API_KEY,
// HOPSWORKS_API_KEY. How a pilot is asked and timed: lib.js. A run ends at its crash, or at --max
// metres.

import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CLASSIC } from '../game/public/sim.js';
import { loadPilot, fly, summary } from './lib.js';

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

const DECIDERS_CFG = {
  semifUrl: process.env.SEMIF_URL, kumoUrl: process.env.KUMO_URL, clefUrl: process.env.CLEF_URL,
  jevUrl: process.env.JEV_URL, jevModel: process.env.JEV_MODEL, jevKey: process.env.TYPESAFE_API_KEY,
  apiKey: process.env.HOPSWORKS_API_KEY,
};

const results = [];
for (const name of args.pilots.split(',').map((p) => p.trim())) {
  const pilot = loadPilot(name, DECIDERS_CFG), runs = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push(await fly(pilot, SEED + i, TRACK, MAX));
    if (!args.json) process.stderr.write(`\r${name}: ${i + 1}/${RUNS}`);
  }
  results.push({ pilot: name, runs, ...summary(runs) });
  if (!args.json) process.stderr.write('\n');
}

if (args.json) console.log(JSON.stringify({ track: TRACK.label, seeds: [SEED, SEED + RUNS - 1], max: MAX, results }, null, 2));
else {
  console.log(`${TRACK.label}, seeds ${SEED} to ${SEED + RUNS - 1}${results.some((r) => r.capped) ? `, runs capped at ${MAX} m` : ''}`);
  console.log(['pilot', 'median', 'mean', 'p90', 'best', 'capped'].map((h) => h.padStart(h === 'pilot' ? 18 : 8)).join('') + '   crashed on');
  for (const r of results) console.log(r.pilot.padStart(18) + [r.median, r.mean, r.p90, r.best, r.capped].map((v) => String(v).padStart(8)).join('') + '   ' + Object.entries(r.causes).map(([c, n]) => `${c} ${n}`).join(', '));
}
