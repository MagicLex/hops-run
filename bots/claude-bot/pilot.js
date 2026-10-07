// Hops Run pilot "claude": answers jevworksDecide({ lane, airborne, ahead }) like the model pilots.
// Searches the next few rows for the cheapest safe plan (a lane at each row, plus a jump or duck where
// one is needed), using the game's own physics: lane changes follow its lateral spring, jumps its
// gravity and jump charge (a charged jump clears a wall). Then it flies the plan's first step.
(() => {
  const LANES = ['left', 'centre', 'right'];
  const GRAVITY = 45, JUMP = 16, CHARGE = { perSecond: 1 / 25, perRow: 0.08, power: 1.6 };
  const LEAD = { up: 0.3, down: 0.25 }; // the game fires an armed jump or duck this long before its row
  // Height above hover needed to fly over each kind: its top + hull radius - hover + margin.
  const CLEAR = { wall: 5.6 + 1.0 - 1.3 + 0.8, low: 1.1 + 1.0 - 1.3 + 0.6, bar: 2.3 + 1.0 - 1.3 + 0.6 };
  // Seconds of lateral spring before the hull is clear of a lane's obstacle (or past a middle one).
  const SHIFT = { clear: 0.17, past: 0.23, open: 0.06 };
  const CLEARED_M = 3.6; // a row leaves `ahead` this far before the hops is past it
  const DEPTH = 5;
  const COST = { move: 0.3, duck: 1, jump: 1.5, wallJump: 2.5 };
  const CRASH = 1000; // cost of a crash at the first row, falling with depth: survive as many rows as possible

  const state = { speed: 45, nearest: null, nearestLanes: {}, at: 0, charge: 0, jumped: false, wasAirborne: false, jump: null, passed: null };
  window.__pilotState = state;

  function track({ airborne, ahead }, now) {
    const dt = (now - state.at) / 1000;
    if (dt > 1) Object.assign(state, { speed: 45, charge: 0, nearest: null, passed: null }); // a new run
    else if (dt > 0) state.charge = Math.min(1, state.charge + CHARGE.perSecond * Math.min(dt, 0.05));
    const near = ahead[0]?.distance ?? null;
    if (near != null && state.nearest != null) {
      if (near < state.nearest && dt > 0.004) {
        const v = (state.nearest - near) / dt;
        if (v > 30 && v < 260) state.speed = 0.7 * state.speed + 0.3 * v;
      } else if (near > state.nearest + 5) { // the nearest row just left `ahead`
        state.charge = Math.min(1, state.charge + CHARGE.perRow);
        state.passed = { lanes: state.nearestLanes, clearAt: now / 1000 + CLEARED_M / state.speed };
      }
    }
    if (airborne && !state.wasAirborne && state.jumped) { // our jump: it spent the charge
      state.jump = { t0: now / 1000, v0: JUMP * (1 + CHARGE.power * state.charge) };
      state.charge = 0;
    }
    if (!airborne) { state.jumped = false; state.jump = null; }
    Object.assign(state, { nearest: near, nearestLanes: ahead[0]?.lanes ?? {}, at: now, wasAirborne: airborne });
  }

  const height = (jump, t) => (jump ? jump.v0 * (t - jump.t0) - (GRAVITY / 2) * (t - jump.t0) ** 2 : 0);
  const inAir = (jump, t) => jump && t > jump.t0 && t < jump.t0 + (2 * jump.v0) / GRAVITY;

  // Seconds a move from `from` to `to` needs before a row with `lanes`, and before that the wait
  // until the previous row (`prev`, passed at `prevAt`) is behind, if the move crosses its obstacles.
  function moveTime(from, to, lanes, prev, prevAt, speed) {
    if (from === to) return 0;
    const between = [Math.min(from, to), Math.max(from, to)];
    const crossed = LANES.slice(between[0], between[1] + 1).filter((_, k) => k + between[0] !== from);
    const wait = prev && crossed.some((l) => prev[l]) ? Math.max(0, prevAt + CLEARED_M / speed - 0.03) : 0;
    const middle = Math.abs(from - to) === 2 && lanes[LANES[1]];
    const shift = middle ? SHIFT.past : lanes[LANES[from]] ? SHIFT.clear : SHIFT.open;
    return wait + shift;
  }

  // Cheapest cost to pass rows[i..] from `lane` at time `t` (seconds from now): `jump` is the jump in
  // flight (or null), `charge` the jump charge at t, `prev`/`prevAt` the previous row and its time.
  // Calls `first(move, cost, at, wait)` for every option at the first row.
  function search(rows, i, lane, t, jump, charge, prev, prevAt, unknownAir, first) {
    if (i >= rows.length || i >= DEPTH) return 0;
    const row = rows[i], at = row.distance / state.speed;
    let best = CRASH / (i + 1);
    for (let target = 0; target < 3; target++) {
      const needed = moveTime(lane, target, row.lanes, prev, prevAt, state.speed);
      if (t + needed > at) continue;
      const wait = target === lane ? 0 : Math.max(0, needed - moveTime(lane, target, row.lanes, null, 0, state.speed));
      const kind = row.lanes[LANES[target]];
      const step = target < lane ? 'left' : target > lane ? 'right' : null;
      const base = Math.abs(target - lane) * COST.move;
      const flying = inAir(jump, at) || (unknownAir && !jump);
      const option = (move, cost, nextJump, nextCharge) => {
        const total = cost + search(rows, i + 1, target, at, nextJump, nextCharge, row.lanes, at, false, null);
        if (first) first(wait > 0 ? 'hold' : step ?? move, total, at);
        best = Math.min(best, total);
      };
      if (!kind) option('hold', base, jump, Math.min(1, charge + CHARGE.perSecond * (at - t)) + CHARGE.perRow);
      else if (flying) { if (jump && height(jump, at) >= CLEAR[kind]) option('hold', base, jump, charge); }
      else {
        if (kind === 'bar') option('down', base + COST.duck, null, Math.min(1, charge + CHARGE.perSecond * (at - t)) + CHARGE.perRow);
        if (!unknownAir) { // jump against this row
          const t0 = Math.max(t, at - LEAD.up);
          const next = { t0, v0: JUMP * (1 + CHARGE.power * Math.min(1, charge + CHARGE.perSecond * (t0 - t))) };
          if (height(next, at) >= CLEAR[kind]) option('up', base + (kind === 'wall' ? COST.wallJump : COST.jump), next, CHARGE.perRow);
        }
      }
    }
    return best;
  }

  function decide(input) {
    const started = performance.now(), nowS = started / 1000;
    track(input, started);
    const { lane, airborne, ahead } = input;
    const rows = ahead.filter((r) => r.distance > 0);
    const current = state.jump && { t0: state.jump.t0 - nowS, v0: state.jump.v0 };
    const passed = state.passed && state.passed.clearAt > nowS ? state.passed : null;
    const scores = { left: Infinity, right: Infinity, hold: Infinity, up: Infinity, down: Infinity };

    search(rows, 0, LANES.indexOf(lane), 0, airborne ? current : null, state.charge,
      passed?.lanes ?? null, passed ? passed.clearAt - nowS - CLEARED_M / state.speed : 0, airborne && !current,
      (move, cost, at) => {
        // Jumps and ducks are armed against the next row: only arm close to it, so a plan that later
        // changes lane is not left with a stale jump.
        if ((move === 'up' || move === 'down') && at > LEAD[move] + 0.12) move = 'hold';
        scores[move] = Math.min(scores[move], cost);
      });

    const moves = Object.keys(scores);
    if (moves.every((m) => scores[m] >= CRASH)) scores[airborne || passed ? 'hold' : 'up'] = 0; // the next row cannot be passed: try a jump
    const lowest = Math.min(...moves.map((m) => scores[m]));
    if (scores.up <= lowest) state.jumped = true;
    const weights = moves.map((m) => Math.exp(-3 * (scores[m] - lowest)));
    const total = weights.reduce((a, b) => a + b, 0);
    return {
      pilot: 'manu.hopsworks.ai',
      model: 'claude',
      moves,
      probabilities: weights.map((w) => w / total),
      forwardMs: performance.now() - started,
    };
  }

  window.jevworksDecide = async (input) => decide(input);
})();
