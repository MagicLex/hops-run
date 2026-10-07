// The arena's core, shared by the CLI (arena.js) and the designer (../designer): load a pilot, fly
// it over a seed on an edition or against a maker, sum up its runs.
//
// A pilot is a bot (bots/<name>/pilot.js, run in a sandbox whose clock is the run's own) or a
// model decider (semif, kumo, jev, clef). It is asked as the page asks it: whenever no answer is
// pending, at most once per 60 Hz frame. An answer lands once the time the pilot reports for it
// (forwardMs) has passed in run time, so a slow model flies blind as long as on the page, and the
// network between the arena and a model counts for nothing. A bot's clock is the run's, so its
// runs replay exactly.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { createRun, DT } from '../game/public/sim.js';
import { DECIDERS, createDeciders } from '../pilot/deciders.js';

const FRAME = Math.round(1 / 60 / DT); // steps per 60 Hz frame
const BETWEEN_RUNS_MS = 5000; // a bot's clock moves on this much between runs, as on the page

// The bots in bots/, by name.
export function bots() {
  const dir = new URL('../bots/', import.meta.url);
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(new URL(`${e.name}/pilot.js`, dir))).map((e) => e.name).sort();
}

// A bot is the browser script it is on the page, run in its own context with the run's clock.
function loadBot(name) {
  const file = new URL(`../bots/${name}/pilot.js`, import.meta.url);
  if (!/^[\w-]+$/.test(name) || !existsSync(file)) return null;
  const clock = { ms: 0 };
  const context = vm.createContext({ performance: { now: () => clock.ms }, console });
  context.window = context;
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file.pathname });
  return { name, bot: true, clock, decide: (view) => context.hopsRunDecide(view) };
}

// cfg: the deciders' settings (pilot/deciders.js), for a decider.
export function loadPilot(name, cfg = {}) {
  const bot = loadBot(name);
  if (bot) return bot;
  const decider = DECIDERS[name];
  if (!decider) throw new Error(`${name}: neither bots/${name}/pilot.js nor a decider (${Object.keys(DECIDERS).join(', ')})`);
  const missing = decider.needs.filter((k) => !cfg[k]);
  if (decider.hopsworks && !cfg.apiKey && !cfg.jwt) missing.push('apiKey');
  if (missing.length) throw new Error(`${name}: missing ${missing.join(', ')}`);
  return { name: decider.pilot, decide: createDeciders(cfg)[name] };
}

// One run of a pilot on { edition, maker } from a seed, ended by a crash or at `max` metres.
export async function fly(pilot, seed, { edition, maker }, max = 100_000) {
  const run = createRun({ seed, edition, maker }), base = pilot.clock?.ms ?? 0;
  let pending = null, step = 0, model = null;
  while (!run.crash && run.distance < max) {
    if (!pending && step % FRAME === 0) {
      if (pilot.clock) pilot.clock.ms = base + run.flightMs;
      const d = await pilot.decide(run.view());
      model ??= d.model ?? null;
      const choice = d.moves[d.probabilities.indexOf(Math.max(...d.probabilities))];
      pending = { at: step + Math.max(1, Math.ceil((d.forwardMs ?? 0) / 1000 / DT)), choice };
    }
    run.tick(); step++;
    if (pending && step >= pending.at) { run.decide(pending.choice); pending = null; }
  }
  if (pilot.clock) pilot.clock.ms = base + run.flightMs + BETWEEN_RUNS_MS;
  // What ended the run: the kind of the part hit, or the rule failed.
  const cause = run.crash && (run.crash.rule ? `${run.crash.rule} rule` : run.crash.row.parts[run.crash.part].kind);
  return { seed, distance: Math.round(run.distance), durationMs: Math.round(run.flightMs), cause, capped: !run.crash, model, redrawn: run.redrawn, pushed: run.pushed };
}

// Median, mean, 90th percentile, best, how many runs were capped, what ended them.
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
export function summary(runs) {
  const d = runs.map((r) => r.distance).sort((a, b) => a - b);
  return {
    median: quantile(d, 0.5), mean: Math.round(d.reduce((a, b) => a + b, 0) / d.length), p90: quantile(d, 0.9), best: d.at(-1),
    capped: runs.filter((r) => r.capped).length,
    causes: Object.fromEntries(Object.entries(runs.reduce((n, r) => (r.cause ? { ...n, [r.cause]: (n[r.cause] ?? 0) + 1 } : n), {})).sort((a, b) => b[1] - a[1])),
  };
}
