// Hops Run pilot "claude-fable": answers hopsRunDecide({ lane, airborne, ahead }) like the model
// pilots, and only from that: the lane, whether the hops is airborne, and the rows ahead with their
// distance and contents. Every frame it plans the whole visible stretch (up to 12 rows): the lane
// at each row, when each lane change starts, where to jump and where to duck, simulating the
// game's lateral spring, gravity and jump charge (a charged jump clears a wall; a full one flies
// over ten rows). The plan surviving the most rows wins, the cheapest among those; its first step
// is flown and everything is planned again next frame.
(() => {
  const LANES = ['left', 'centre', 'right'];
  const G = 45, G_OVER = 55; // gravity as the game has it, and pessimistic for clearing obstacles
  const JUMP = 16, CHARGE = { perSecond: 1 / 25, perRow: 0.08, power: 1.6 };
  const HOVER = 1.3, DUCK_HOVER = 0.45;
  const LEAD = { up: 0.29, down: 0.25 }; // the game fires an armed jump or duck this long before its row
  const FRAME = 0.017, ARM = 0.1; // arm a jump or duck when it fires within ARM seconds
  // Height of the hops centre that clears each kind: obstacle top + hull radius + margin.
  const OVER = { wall: 5.6 + 1.0 + 0.6, low: 1.1 + 1.0 + 0.5, bar: 2.3 + 1.0 + 0.5 };
  // The lateral spring (k 260, c 26, lanes 2.6 m apart): seconds into a lane change until the hull
  // is exposed to the lane(s) entered, clear of the lane left, and settled; each with a margin.
  const MOVE = {
    1: { settle: 0.19, leave: 0.18, enter: 0.025 },
    2: { settle: 0.23, leave: 0.1, midIn: 0.02, midOut: 0.21, enter: 0.07 },
  };
  const CLEARED_M = 3.6; // metres after a row leaves `ahead` until the hops is past it
  // Taking off and landing squash the hops, widening its hull by up to a quarter for WIDE seconds:
  // a lane just left stays within reach for longer.
  const WIDE = { seconds: 0.2, extra: 0.07 };
  // A duck lowers the hover: it takes `on` seconds, is held for `hold`, and while the hops drops to
  // the lower hover the game counts it airborne, so no jump can fire until `drop` seconds in.
  const DUCK = { on: 0.15, hold: 0.72, drop: 0.27 };
  const DECIDE = 0.02; // seconds after a row before the next move or jump can go
  const LAND_MARGIN = 0.1; // seconds after a modelled landing before the next jump is counted on
  const AIR_GUESS = 0.2; // seconds a lift-off that is not our jump (a crest) is assumed to last
  // A lane change is the one move hills cannot spoil, so it is the cheapest; a duck costs more than
  // a lane change and passing under a bar carries its own risk (on a crest the hops floats above
  // the lowered hover and clips the bar).
  const COST = { move: 0.1, jump: 0.25, duck: 0.2, exposed: 0.05, underBar: 0.15 };
  // Hills change the pull towards the track by up to four times, which the pilot cannot see: a jump
  // ending early (a dip) or a lift-off that is not a jump (a crest) marks the next HILLY seconds,
  // when jumps and ducks are trusted less and lane changes preferred.
  const HILLY = { seconds: 1.2, jump: 1.0, duck: 0.5, gOver: 80 };
  const MAX_ROWS = 12, NODE_BUDGET = 60000;

  // --- what we know about the hops, kept between frames ---------------------------------------
  const me = {
    speed: 45, at: 0, lane: 1, nearest: null, nearestLanes: {},
    charge: 0, jump: null, airSince: null, passed: null, move: null, duckAt: -9,
    armedJumpUntil: 0, wantMove: null, pending: null, wasAirborne: false, duckDrop: false, hillyUntil: 0, landedAt: null,
  };
  window.__pilotState = me;

  const isDucked = (duckAt, t) => t >= duckAt + DUCK.on && t <= duckAt + DUCK.hold;
  const span = (M) => MOVE[Math.abs(M.to - M.from)];

  function observe({ lane, airborne, ahead }, now) {
    const t = now / 1000, dt = t - me.at / 1000;
    const laneIndex = LANES.indexOf(lane);
    const near = ahead[0]?.distance ?? null;
    if (dt > 1) { // a new run
      Object.assign(me, { speed: 45, charge: 0, jump: null, airSince: null, passed: null, move: null, duckAt: -9, armedJumpUntil: 0, wantMove: null, pending: null, wasAirborne: false, duckDrop: false, hillyUntil: 0, landedAt: null });
    } else {
      me.charge = Math.min(1, me.charge + CHARGE.perSecond * dt);
      if (near != null && me.nearest != null && dt > 0.004) {
        if (near < me.nearest) { const v = (me.nearest - near) / dt; if (v > 20 && v < 300) me.speed = v; }
        else if (near > me.nearest + 3) { // the nearest row left `ahead`
          me.charge = Math.min(1, me.charge + CHARGE.perRow);
          me.passed = { lanes: me.nearestLanes, clearAt: t + CLEARED_M / me.speed };
        }
      } else if (near == null) me.speed += 1.6 * dt;
      if (me.wantMove && laneIndex === me.wantMove.to) me.move = me.wantMove;
      if (airborne && !me.wasAirborne && !me.jump) {
        if (t - me.duckAt >= 0 && t - me.duckAt < 0.1) me.duckDrop = true; // the hover dropped away under us
        else if (t <= me.armedJumpUntil) { // our jump took off
          me.jump = { t0: t - FRAME, v0: JUMP * (1 + CHARGE.power * me.charge), h0: isDucked(me.duckAt, t - FRAME) ? DUCK_HOVER : HOVER };
          me.charge = 0; me.armedJumpUntil = 0;
        } else me.hillyUntil = t + HILLY.seconds; // lifted off a crest
      }
    }
    if (!airborne) {
      if (me.jump) { me.landedAt = t; if (landingOf(me.jump) - t > 0.15) me.hillyUntil = t + HILLY.seconds; } // early: a dip
      me.jump = null; me.airSince = null; me.duckDrop = false;
    }
    else if (!me.jump && !me.duckDrop && me.airSince == null) me.airSince = t;
    me.wasAirborne = airborne;
    if (me.move && t >= me.move.ts + span(me.move).settle) me.move = null;
    Object.assign(me, { nearest: near, nearestLanes: ahead[0]?.lanes ?? {}, at: now, lane: laneIndex, wantMove: null });
  }

  // --- the plan: rows ahead, times relative to now ------------------------------------------------
  let rows, at, clearDelay, nodes, memo, cost, gOver;

  const rowsPassedBy = (t) => { let k = 0; while (k < at.length && at[k] + clearDelay <= t) k++; return k; };
  const chargeAt = (C, t) => Math.min(1, C.c + CHARGE.perRow * Math.max(0, rowsPassedBy(t) - C.k) + CHARGE.perSecond * Math.max(0, t - C.t));
  const heightAt = (J, t, g) => { const tau = t - J.t0; return tau <= 0 ? J.h0 : J.h0 + J.v0 * tau - (g / 2) * tau * tau; };
  const landingOf = (J) => J.t0 + (J.v0 + Math.sqrt(J.v0 * J.v0 + 2 * G * (J.h0 - HOVER))) / G;

  // Lanes whose obstacles the hull touches at time t: one when settled, more during a lane change.
  function exposure(S, t, wide = false) {
    const M = S.move;
    if (!M) return [S.lane];
    const tau = t - M.ts, n = Math.abs(M.to - M.from), m = MOVE[n], extra = wide ? WIDE.extra : 0;
    if (tau >= m.settle + 0.02 + extra) return [M.to];
    if (tau <= -0.02) return [M.from];
    const set = [];
    set.moving = true;
    if (tau < m.leave + extra) set.push(M.from);
    if (n === 2 && tau > m.midIn && tau < m.midOut + extra) set.push((M.from + M.to) / 2);
    if (tau > m.enter) set.push(M.to);
    if (tau >= m.settle) set.push(M.to);
    return set;
  }
  // Is the hull widened at time t: just after a take-off or a landing?
  const isWide = (S, t) => (S.jump != null && t - S.jump.t0 <= WIDE.seconds) || (S.landedAt != null && t - S.landedAt <= WIDE.seconds);

  // A ducked hops passes under a bar only between its posts: not while changing lane.
  // How the hops gets past a row: 0 clean, COST.underBar when it relies on a duck, null for a crash.
  // How the hops gets past a row: 0 clean, COST.underBar when it relies on a duck, null for a crash.
  function passes(lanes, exp, h, grounded, ducked) {
    let risk = 0;
    for (const l of exp) {
      const kind = lanes[LANES[l]];
      if (!kind || h >= OVER[kind]) continue;
      if (kind === 'bar' && grounded && ducked && !exp.moving) { risk = COST.underBar; continue; }
      return null;
    }
    return risk;
  }

  // Can a lane change M start without touching the obstacles of the row just passed (prev)?
  function prevSafe(S, M, prev) {
    const tc = prev.clearAt - 0.001;
    if (tc <= M.ts) return true;
    const h = S.jump && tc < landingOf(S.jump) ? heightAt(S.jump, tc, gOver) : -1;
    const exp = exposure({ ...S, lane: M.to, move: M }, tc, isWide(S, tc));
    if (exp.moving && prev.lanes[LANES[M.from]] === 'bar' && h < OVER.bar) return false; // between its posts
    for (const l of exp) {
      const kind = prev.lanes[LANES[l]];
      if (l !== M.from && kind && h < OVER[kind]) return false;
    }
    return true;
  }

  // Everything the hops can do about row i from state S: hold or change lane, and jump or duck.
  function expand(i, S) {
    const td = i === 0 ? 0 : at[i - 1] + DECIDE;
    const prev = i === 0 ? S.passed : { lanes: rows[i - 1].lanes, clearAt: at[i - 1] + clearDelay };
    const tLand = Math.max(S.jump ? landingOf(S.jump) + LAND_MARGIN : (S.airUntil ?? 0), S.duckAt + DUCK.drop);
    const settled = !S.move || S.move.ts + span(S.move).settle <= td;
    const laneOptions = [{ S, cost: 0 }];
    if (settled) for (const T of [S.lane - 1, S.lane + 1, S.lane - 2, S.lane + 2]) {
      if (T < 0 || T > 2) continue;
      const M = { from: S.lane, to: T, ts: td };
      if (prev && prev.clearAt > td && !prevSafe(S, M, prev)) M.ts = prev.clearAt;
      laneOptions.push({ S: { ...S, lane: T, move: M }, cost: COST.move * Math.abs(T - S.lane), moveTo: T, ts: M.ts });
    }
    const out = [];
    const hasBar = Object.values(rows[i].lanes).includes('bar');
    for (const o of laneOptions) {
      out.push(o);
      if (tLand <= at[i] - 0.03) {
        const t0 = Math.max(td, tLand, at[i] - LEAD.up);
        const J = { t0, v0: JUMP * (1 + CHARGE.power * chargeAt(S.C, t0)), h0: isDucked(S.duckAt, t0) ? DUCK_HOVER : HOVER };
        out.push({ ...o, S: { ...o.S, jump: J, airUntil: null, C: { c: 0, t: t0, k: rowsPassedBy(t0) } }, cost: o.cost + cost.jump, jumpAt: t0 });
      }
      if (hasBar && tLand <= at[i] - DUCK.on) {
        const tf = Math.max(td, tLand, at[i] - LEAD.down);
        if (tf + DUCK.on <= at[i]) out.push({ ...o, S: { ...o.S, duckAt: tf }, cost: o.cost + cost.duck, duckAt: tf });
      }
    }
    return out;
  }

  // The hops meets row i in state S: the state after it, or null for a crash.
  function cross(i, S) {
    const t = at[i];
    let h = HOVER, grounded = true;
    if (S.jump && t < landingOf(S.jump)) { h = heightAt(S.jump, t, gOver); grounded = false; }
    else if (!S.jump && S.airUntil != null && t < S.airUntil) { h = -1; grounded = false; }
    const exp = exposure(S, t, isWide(S, t));
    const risk = passes(rows[i].lanes, exp, h, grounded, isDucked(S.duckAt, t));
    if (risk == null) return null;
    const next = { ...S, passed: null };
    if (grounded) { if (next.jump) next.landedAt = landingOf(next.jump); next.jump = null; next.airUntil = null; }
    if (next.move && t >= next.move.ts + span(next.move).settle) next.move = null;
    return { S: next, penalty: risk + (exp.length > 1 ? COST.exposed : 0) };
  }

  const q = (x) => Math.round(x * 200);
  const keyOf = (i, S) => `${i}|${S.lane}|${S.move ? `${S.move.from}:${q(S.move.ts)}` : ''}|${S.jump ? `${q(S.jump.t0)}:${Math.round(S.jump.v0)}:${S.jump.h0}` : ''}|${S.airUntil != null ? q(S.airUntil) : ''}|${q(S.duckAt)}|${S.landedAt != null ? q(S.landedAt) : ''}|${S.C.c.toFixed(2)}:${q(S.C.t)}:${S.C.k}`;
  const terminal = (S) => 0.3 * chargeAt(S.C, at[at.length - 1] + 0.5) + (S.lane === 1 ? 0.04 : 0);
  const better = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

  // Best outcome from row i on: [rows survived, score].
  function search(i, S) {
    if (i >= rows.length) return [i, terminal(S)];
    const key = keyOf(i, S);
    const hit = memo.get(key);
    if (hit) return hit;
    nodes++;
    let best = [i, -1e9];
    for (const o of expand(i, S)) {
      const c = cross(i, o.S);
      let val;
      if (!c) val = [i, -o.cost];
      else { const f = search(i + 1, c.S); val = [f[0], f[1] - o.cost - c.penalty]; }
      if (better(val, best)) best = val;
      if (nodes > NODE_BUDGET) break;
    }
    if (nodes <= NODE_BUDGET) memo.set(key, best);
    return best;
  }

  function decide(input) {
    const started = performance.now(), nowS = started / 1000;
    observe(input, started);
    const moves = ['left', 'right', 'hold', 'up', 'down'];
    const answer = (move) => {
      const probabilities = moves.map((m) => (m === move ? 0.92 : 0.02));
      return { pilot: 'manu.hopsworks.ai', model: 'claude-fable', moves, probabilities, forwardMs: performance.now() - started };
    };

    // The second step of a two-lane change goes at once.
    if (me.pending) {
      const p = me.pending; me.pending = null;
      if (me.lane !== p.to && Math.abs(p.to - me.lane) === 1) {
        me.wantMove = { from: p.from, to: p.to, ts: p.ts };
        me.move = me.wantMove;
        return answer(p.to > me.lane ? 'right' : 'left');
      }
    }

    rows = input.ahead.filter((r) => r.distance > 0).slice(0, MAX_ROWS);
    if (!rows.length) return answer('hold');
    clearDelay = CLEARED_M / me.speed;
    at = rows.map((r) => r.distance / me.speed);
    nodes = 0; memo = new Map();
    const hilly = me.hillyUntil > nowS;
    cost = hilly ? { ...COST, jump: HILLY.jump, duck: HILLY.duck } : COST;
    gOver = hilly ? HILLY.gOver : G_OVER;

    let jump = me.jump && { ...me.jump, t0: me.jump.t0 - nowS }, airUntil = null;
    if (jump && landingOf(jump) <= 0) jump = null; // still airborne past the model's landing: a crest
    if (!jump && me.airSince != null) airUntil = AIR_GUESS;
    const S0 = {
      lane: me.lane,
      move: me.move && { ...me.move, ts: me.move.ts - nowS },
      jump, airUntil,
      C: { c: me.charge, t: 0, k: 0 },
      duckAt: me.duckAt - nowS,
      landedAt: me.landedAt != null ? me.landedAt - nowS : null,
      passed: me.passed && me.passed.clearAt > nowS ? { lanes: me.passed.lanes, clearAt: me.passed.clearAt - nowS } : null,
    };

    let best = null, bestVal = [-1, -1e9];
    for (const o of expand(0, S0)) {
      const c = cross(0, o.S);
      let val;
      if (!c) val = [0, -o.cost];
      else { const f = search(1, c.S); val = [f[0], f[1] - o.cost - c.penalty]; }
      if (better(val, bestVal)) { bestVal = val; best = o; }
    }
    me.lastPlan = { survived: bestVal[0], nodes, rows: rows.length, hilly };

    if (best.moveTo != null && best.ts <= FRAME) {
      const step = best.moveTo > me.lane ? me.lane + 1 : me.lane - 1;
      me.wantMove = { from: me.lane, to: step, ts: nowS };
      if (Math.abs(best.moveTo - me.lane) === 2) me.pending = { from: me.lane, to: best.moveTo, ts: nowS };
      return answer(step > me.lane ? 'right' : 'left');
    }
    if (best.jumpAt != null && best.jumpAt <= ARM) {
      me.armedJumpUntil = nowS + best.jumpAt + 0.08;
      return answer('up');
    }
    if (best.duckAt != null && best.duckAt <= ARM) {
      me.duckAt = nowS + Math.max(best.duckAt, FRAME);
      return answer('down');
    }
    return answer('hold');
  }

  window.hopsRunDecide = async (input) => decide(input);
})();
