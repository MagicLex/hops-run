// Hops Run simulation: the track, the rows and speed gates on it, and the hops' physics, with no
// rendering. The page draws a run from it, the server reads its constants, the arena (../../arena)
// flies pilots on it headless.
//
// Time advances in fixed steps of DT. A run draws from three streams seeded from its seed (track,
// rows, gates), so a seed and the same moves at the same steps fly the same run, whatever the frame
// rate.
//
// No row is ever impossible. A row is placed only once a witness gets through it: hopses flown by
// search through this same physics, with the moves a model pilot has (a lane change at any time, a
// jump or duck from LEAD seconds before the next row), each one past every row placed before. A
// rejected row is drawn again, and moved further down the track if it keeps failing.
//
// What a track holds is an edition: data naming its obstacle kinds, zones and rules and how often
// each comes. CLASSIC is the game's own; other editions are written by a designer and published
// by the server, each checked against BOUNDS.

import * as THREE from 'three';

export const LANES = ['left', 'centre', 'right'];
export const LANE_X = 2.6;
export const TRACK_W = LANE_X * 3 + 1.2;
export const AHEAD = 360, BEHIND = 60; // metres of track in view ahead, kept behind
const PLACE = 600; // metres ahead rows are placed, when the page gives the time (prepare)
export const SPEED = { start: 45, max: 160, gain: 1.6 }; // m/s, m/s per s
export const BOOST = { kick: 45, decay: 18 }; // m/s added by a gate, m/s lost per s
// Rows close in: the gap an edition draws is scaled down, to `floor` x after `over` metres.
const TIGHTEN = { floor: 0.55, over: 5000 };
export const PAD_GAP = { min: 140, max: 260 };
export const STEP = 1; // metres per track sample
const ALTITUDE = 15; // metres the generator steers the track back towards
const UNLOCK = { side: 300, wallride: 400, cork: 500, invert: 700, loop: 900 }; // metres before each segment can appear
// Segments where the frame is meant to lean: the upright correction stays off through them.
const LEANING = new Set(['turn', 'side', 'cork', 'loop', 'roll', 'held']);
export const HOVER = 1.3, GRAVITY = 45;
export const SPRING = { k: 260, c: 26 }; // lateral spring stiffness and damping
export const JUMP = 16, DUCK = { hover: 0.45, time: 0.7, flat: 0.35, narrow: 0.15 }; // m/s up; hover height, seconds, and how much the hops squeezes when ducking
// Jump charge: fills while flying and with every cleared row; a jump spends all of it, up to
// (1 + power) times the base jump.
export const CHARGE = { perSecond: 1 / 25, perRow: 0.08, power: 1.6 };
// The hops as an ellipsoid for collisions: radii across, up and along, centred where its body is.
export const HULL = { x: 1.0, y: 1.0, z: 1.5 };
// The hops' body: length along the track, radius, and the share of its length ahead of its origin.
export const SHIP = { length: 3.0, radius: 1.0, nose: 0.42 };
const CENTRE = SHIP.length * (0.5 - SHIP.nose); // origin to body centre, backwards
export const GATE_R = 1.7; // speed gate ring radius, centred at hover height
export const START = 22; // metres along the track where a run takes off
// A pilot's jump or duck is armed against the next row and fires this many seconds before it.
export const LEAD = { up: 0.3, down: 0.25 };
export const DT = 1 / 120;
// The witness: a pilot's choice every DECIDE steps, at most WIDTH hopses kept, a row drawn again
// RETRIES times before it moves PUSH metres down the track.
const WITNESS = { decide: 4, width: 32, retries: 12, push: 10, giveUp: 400 };

// --- randomness ----------------------------------------------------------------------------------
export function stream(seed, n) {
  let a = (seed ^ Math.imul(n, 0x9e3779b9)) | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (rng, a, b) => a + rng() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;

// --- the track: a curve sampled every STEP metres, with its frame ---------------------------------
// Each segment gives yaw, pitch and roll rates (rad per metre) over its length. `ease` turns by a
// total angle and ends straight; `wave` swings out to a peak angle and back to zero.
const ease = (total, len) => (u) => (total / len) * (1 - Math.cos(2 * Math.PI * u));
const wave = (peak, len) => (u) => ((peak * Math.PI) / len) * Math.sin(2 * Math.PI * u);
// A loop eased once round (ease(2 * PI)) comes out this share of its length ahead of where it went in.
const LOOP_RUN = Array.from({ length: 1000 }, (_, i) => Math.cos(2 * Math.PI * ((i + 0.5) / 1000) - Math.sin(2 * Math.PI * ((i + 0.5) / 1000)))).reduce((a, c) => a + c) / 1000;
const zero = () => 0;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const AX = { fwd: V(0, 0, -1), up: V(0, 1, 0), right: V(1, 0, 0) };
const tv = new THREE.Vector3(), tq = new THREE.Quaternion(), te = new THREE.Euler(0, 0, 0, 'YXZ');

function createTrack(rng) {
  const P = [V(0, 0, 0)], Q = [new THREE.Quaternion()], kinds = ['straight'], pitches = [0];
  const gen = { p: V(0, 0, 0), q: new THREE.Quaternion(), seg: null, at: 0, minY: 0, queue: [] };

  function pickSegment() {
    const s = P.length * STEP;
    const fwd = tv.copy(AX.fwd).applyQuaternion(gen.q);
    const heading = Math.atan2(-fwd.x, -fwd.z); // 0 when the track runs down -z
    const options = [['straight', 3], ['turn', 4], ['hill', 4]];
    if (s > UNLOCK.side) options.push(['side', 2]);
    if (s > UNLOCK.wallride) options.push(['wallride', 1.2]);
    if (s > UNLOCK.cork) options.push(['cork', 1.2]);
    if (s > UNLOCK.invert) options.push(['invert', 1]);
    if (s > UNLOCK.loop) options.push(['loop', 1]);
    let roll = rng() * options.reduce((a, [, w]) => a + w, 0), kind = 'straight';
    for (const [k, w] of options) { if ((roll -= w) <= 0) { kind = k; break; } }
    const side = () => (rng() < 0.5 ? 1 : -1);
    if (kind === 'turn') {
      // Turn back towards -z once the heading has wandered; bank into the turn.
      const dir = Math.abs(heading) > 0.7 ? -Math.sign(heading) : side(), len = between(rng, 110, 200);
      return { kind, len, yaw: ease(dir * between(rng, 0.5, 1.3), len), pitch: zero, roll: wave(dir * between(rng, 0.3, 0.65), len) };
    }
    if (kind === 'side') {
      // A hard turn banked onto its side, roller coaster style: near vertical mid-corner.
      const dir = Math.abs(heading) > 0.7 ? -Math.sign(heading) : side(), len = between(rng, 200, 300);
      return { kind, len, yaw: ease(dir * between(rng, 0.9, 1.6), len), pitch: zero, roll: wave(dir * between(rng, 1.3, 1.57), len) };
    }
    if (kind === 'hill') {
      // Climb or dive, steering the altitude back into a band.
      const dir = gen.p.y < -5 ? 1 : gen.p.y > 35 ? -1 : side(), len = between(rng, 90, 170);
      return { kind, len, yaw: zero, pitch: wave(dir * between(rng, 0.22, 0.45), len), roll: zero };
    }
    if (kind === 'wallride' || kind === 'invert') {
      // Roll onto the side or upside down, stay there a while, roll back.
      const angle = kind === 'invert' ? Math.PI * side() : (Math.PI / 2) * side(), turn = between(rng, 120, 170);
      return [
        { kind: 'roll', len: turn, yaw: zero, pitch: zero, roll: ease(angle, turn) },
        { kind: 'held', len: between(rng, 200, 400), yaw: zero, pitch: zero, roll: zero },
        { kind: 'roll', len: turn, yaw: zero, pitch: zero, roll: ease(-angle, turn) },
      ];
    }
    // Corkscrews and loops are helices: the frame turns once round an axis fixed at their start
    // (axis, from the frame's forward and right) and comes out parallel to where it went in. The
    // corkscrew winds round a line 8 to 20 m above the track, the track's up always towards it, so
    // the hops is pressed on all the way round; it veers a little to the side it rolls to.
    if (kind === 'cork') {
      const len = between(rng, 400, 560), a = Math.asin((2 * Math.PI * between(rng, 8, 20)) / len), dir = side();
      return { kind, len, yaw: zero, pitch: zero, roll: zero, turn: ease(Math.PI * 2, len), axis: (f, r) => f.multiplyScalar(dir * Math.cos(a)).addScaledVector(r, Math.sin(a)) };
    }
    // Loops are 400 to 500 m round (radius 64 to 80 m), so the chase camera sees round them, and
    // come out 18 to 27 m (two to three track widths) to the side, clear of their own way in.
    if (kind === 'loop') {
      const len = between(rng, 400, 500), b = Math.asin(between(rng, TRACK_W * 2, TRACK_W * 3) / (len * (1 - LOOP_RUN))) * side();
      return { kind, len, yaw: zero, pitch: zero, roll: zero, turn: ease(Math.PI * 2, len), axis: (f, r) => r.multiplyScalar(Math.cos(b)).addScaledVector(f, Math.sin(b)) };
    }
    return { kind, len: between(rng, 50, 140), yaw: zero, pitch: zero, roll: zero };
  }

  function stepTrack() {
    if (!gen.seg || gen.at >= gen.seg.len) {
      if (!gen.queue.length) gen.queue.push(...[].concat(P.length < 220 ? { kind: 'straight', len: 220, yaw: zero, pitch: zero, roll: zero } : pickSegment()));
      gen.seg = gen.queue.shift(); gen.at = 0;
    }
    const { seg } = gen, u = (gen.at + STEP / 2) / seg.len;
    let yaw = seg.yaw(u) * STEP, pitch = seg.pitch(u) * STEP, roll = seg.roll(u) * STEP, pitchRate = seg.pitch(u);
    if (seg.axis) {
      const fwd = new THREE.Vector3().copy(AX.fwd).applyQuaternion(gen.q), right = new THREE.Vector3().copy(AX.right).applyQuaternion(gen.q);
      seg.fixed ??= seg.axis(fwd, right.clone()).normalize();
      // The share of the turn that pitches the track, for the hops' magnetic gravity.
      pitchRate = seg.turn(u) * seg.fixed.dot(right);
      gen.q.premultiply(tq.setFromAxisAngle(seg.fixed, seg.turn(u) * STEP));
    }
    // Outside corkscrews and loops, ease the frame back upright and level, so turns and hills
    // never accumulate a lean.
    if (seg.kind !== 'cork' && seg.kind !== 'loop') {
      const right = tv.copy(AX.right).applyQuaternion(gen.q);
      if (!LEANING.has(seg.kind)) roll -= right.y * 0.03 * STEP;
      // Hold the nose towards a slope that brings the altitude back to the band around ALTITUDE,
      // through the local up: no effect on a side, reversed upside down.
      const upY = tv.copy(AX.up).applyQuaternion(gen.q).y;
      const want = THREE.MathUtils.clamp(-(gen.p.y - ALTITUDE) * 0.004, -0.12, 0.12);
      if (seg.kind !== 'hill') pitch -= (tv.copy(AX.fwd).applyQuaternion(gen.q).y - want) * upY * 0.02 * STEP;
    }
    // Yaw turns about the world vertical, so a corner banked onto its side still turns on the level;
    // pitch and roll are about the track's own axes.
    gen.q.premultiply(tq.setFromAxisAngle(AX.up, yaw)).multiply(tq.setFromEuler(te.set(pitch, 0, roll, 'YXZ'))).normalize();
    gen.p.addScaledVector(tv.copy(AX.fwd).applyQuaternion(gen.q), STEP);
    gen.minY = Math.min(gen.minY, gen.p.y);
    P.push(gen.p.clone()); Q.push(gen.q.clone()); kinds.push(seg.kind); pitches.push(pitchRate);
    gen.at += STEP;
  }
  const extend = (s) => { while (P.length * STEP < s + 2) stepTrack(); };
  const index = (s) => { extend(s); return Math.floor(Math.max(0, s) / STEP); };
  const F = { p: V(), q: new THREE.Quaternion(), fwd: V(), up: V(), right: V() };
  return {
    // Frame at s: position, orientation and its axes, interpolated between samples.
    frameAt(s, out = F) {
      s = Math.max(0, s);
      extend(s);
      const i = Math.floor(s / STEP), f = s / STEP - i;
      out.p.lerpVectors(P[i], P[i + 1], f);
      out.q.slerpQuaternions(Q[i], Q[i + 1], f);
      out.fwd.copy(AX.fwd).applyQuaternion(out.q); out.up.copy(AX.up).applyQuaternion(out.q); out.right.copy(AX.right).applyQuaternion(out.q);
      return out;
    },
    pitchAt: (s) => pitches[index(s)],
    kindAt: (s) => kinds[index(s)],
    inLoop(s) { const k = kinds[index(s)]; return k === 'cork' || k === 'loop'; },
    get minY() { return gen.minY; },
  };
}

// --- obstacles and zones -------------------------------------------------------------------------
// An obstacle kind is data: boxes (parts) set in the lane it stands in. A part has w, h, d in metres
// (h may be 'height': the row's own, within the kind's `height` range), x (metres across from the
// lane's centre), lift (metres from the track to its bottom), post (a thin support), and may move
// along a path [{ at, lane, lift }]: where it is when the hops is `at` metres from the row, `lane`
// lanes across from where it stands, its bottom at `lift`, in between eased linearly. Each hops,
// the pilot's or one the witness flies, sees a part move with its own approach. `describe` is what
// a pilot is told it is.
const BAR = { w: LANE_X - 0.1, t: 0.6, bottom: 1.7 };
const posts = [-1, 1].map((side) => ({ w: 0.16, h: BAR.bottom, d: 0.16, x: side * (BAR.w / 2 - 0.08), post: true }));
export const KINDS = {
  wall: { describe: 'a wall', height: [4.6, 5.6], parts: [{ w: LANE_X - 0.4, h: 'height', d: 1.6 }] },
  low: { describe: 'a low block', height: [0.9, 1.1], parts: [{ w: LANE_X - 0.4, h: 'height', d: 2.2 }] },
  // Full lane wide on thin posts at the lane edges, so a ducking hops squeezes through.
  bar: { describe: 'a bar', parts: [...posts, { w: BAR.w, h: BAR.t, d: 1.0, lift: BAR.bottom }] },
  sweeper: { describe: 'a wall that slides two lanes to the right while the hops comes from 80 m to 20 m away', parts: [{ w: LANE_X - 0.4, h: 4.6, d: 1.6, path: [{ at: 80, lane: 0 }, { at: 20, lane: 2 }] }] },
  dropbar: { describe: 'a bar that falls from overhead onto its posts while the hops comes from 50 m to 15 m away', parts: [...posts, { w: BAR.w, h: BAR.t, d: 1.0, lift: BAR.bottom, path: [{ at: 50, lift: 4.4 }, { at: 15, lift: BAR.bottom }] }] },
};
// A zone changes how the hops flies from `before` metres ahead of its row to `after` metres past
// it: gravity and grip (the lateral spring) scaled, or left and right swapped. `tint` is the colour
// the page lays on that stretch of track.
export const ZONES = {
  drift: { describe: 'a drift zone: lane changes are slow and sway', grip: 0.45, before: 80, after: 10, tint: 'ink' },
  float: { describe: 'a float zone: gravity is halved, so jumps fly higher and longer', gravity: 0.5, before: 80, after: 10, tint: 'green' },
  mirror: { describe: 'a mirror zone: left moves the hops right and right moves it left', mirror: true, before: 80, after: 10, tint: 'rust' },
};
// A rule is checked as the hops clears a row (its lane is the one it is over then); a row whose
// rule fails counts as a crash. The vocabulary is fixed; editions choose from it.
const laneOf = (b) => Math.min(2, Math.max(0, Math.round(b.x / LANE_X) + 1));
export const RULES = {
  bounce: { describe: 'a bounce rule: clear this row in a different lane from the row before', ok: (b) => b.crossed === null || laneOf(b) !== b.crossed },
  hold: { describe: 'a hold rule: clear this row in the same lane as the row before', ok: (b) => b.crossed === null || laneOf(b) === b.crossed },
  air: { describe: 'an air rule: be in the air as the hops clears this row', ok: (b) => b.airborne },
  duck: { describe: 'a duck rule: be ducking as the hops clears this row', ok: (b) => b.duckT > 0 },
};

// What a kind or a zone may be: sizes, lift and path within these, at most `path` points, scales
// within `scale`. Whatever passes still has to get past the witness.
const BOUNDS = { w: [0.1, LANE_X - 0.1], h: [0.1, 6], d: [0.1, 3], lift: [0, 5], at: [0, AHEAD], lane: [-2, 2], path: 4, scale: [0.4, 1.6], before: [0, 120], after: [0, 40] };
const ZONE_REACH = BOUNDS.before[1];
// What an edition may be: a share of two-lane rows, chances of a zone or a rule, the gap range
// (metres, before rows tighten), names, how many kinds and zones of its own.
const EDITION = { two: [0, 0.8], p: [0, 0.5], gap: [30, 90], name: /^[\w .:-]{1,40}$/, id: /^[a-z][a-z0-9-]{1,23}$/, own: 8, describe: 300 };

const within = (v, [lo, hi]) => typeof v === 'number' && v >= lo && v <= hi;
export function checkKind(name, k) {
  const bad = (why) => { throw new Error(`kind ${name}: ${why}`); };
  if (typeof k?.describe !== 'string' || !k.describe) bad('describe it for the pilots');
  if (k.height && !(within(k.height[0], BOUNDS.h) && within(k.height[1], BOUNDS.h) && k.height[0] <= k.height[1])) bad(`height within ${BOUNDS.h}`);
  if (!Array.isArray(k.parts) || !k.parts.length) bad('at least one part');
  for (const p of k.parts) {
    if (p.h === 'height' ? !k.height : !within(p.h, BOUNDS.h)) bad(`part h within ${BOUNDS.h}, or 'height' with a height range`);
    for (const dim of ['w', 'd']) if (!within(p[dim], BOUNDS[dim])) bad(`part ${dim} within ${BOUNDS[dim]}`);
    if (p.lift !== undefined && !within(p.lift, BOUNDS.lift)) bad(`part lift within ${BOUNDS.lift}`);
    if (p.x !== undefined && !within(p.x, [-LANE_X / 2, LANE_X / 2])) bad('part x within its lane');
    if (p.path !== undefined) {
      if (!Array.isArray(p.path) || p.path.length < 2 || p.path.length > BOUNDS.path) bad(`a path of 2 to ${BOUNDS.path} points`);
      for (const q of p.path) {
        if (!within(q.at, BOUNDS.at)) bad(`path at within ${BOUNDS.at}`);
        if (q.lane !== undefined && !within(q.lane, BOUNDS.lane)) bad(`path lane within ${BOUNDS.lane}`);
        if (q.lift !== undefined && !within(q.lift, BOUNDS.lift)) bad(`path lift within ${BOUNDS.lift}`);
      }
    }
  }
}
export function checkZone(name, z) {
  const bad = (why) => { throw new Error(`zone ${name}: ${why}`); };
  if (typeof z?.describe !== 'string' || !z.describe) bad('describe it for the pilots');
  for (const k of ['gravity', 'grip']) if (z[k] !== undefined && !within(z[k], BOUNDS.scale)) bad(`${k} within ${BOUNDS.scale}`);
  if (z.mirror !== undefined && typeof z.mirror !== 'boolean') bad('mirror is true or false');
  for (const k of ['before', 'after']) if (!within(z[k], BOUNDS[k])) bad(`${k} within ${BOUNDS[k]}`);
}
for (const [name, k] of Object.entries(KINDS)) checkKind(name, k);
for (const [name, z] of Object.entries(ZONES)) checkZone(name, z);

// A row's parts, ready to collide: the box where each stands (centre s, x, lift; half sizes), and
// its path in metres across.
function partsOf(s, lanes, kinds) {
  const out = [];
  for (const [l, { kind, height }] of Object.entries(lanes)) {
    const lx = (LANES.indexOf(l) - 1) * LANE_X;
    for (const p of kinds[kind].parts) {
      const hh = (p.h === 'height' ? height : p.h) / 2, lift = p.lift ?? 0;
      const path = p.path?.map((q) => ({ at: q.at, dx: (q.lane ?? 0) * LANE_X, lift: q.lift ?? lift })).sort((a, b) => b.at - a.at);
      out.push({ kind, post: !!p.post, s, x: lx + (p.x ?? 0), lift, hw: p.w / 2, hh, hd: p.d / 2, path });
    }
  }
  return out;
}
// A part's box for a hops `d` metres from its row: centre (s, x, h) and half sizes.
export function boxAt(p, d) {
  if (!p.path) return p.box ??= { s: p.s, x: p.x, h: p.lift + p.hh, hw: p.hw, hh: p.hh, hd: p.hd };
  // The path runs from its farthest point (q[0]) to its nearest; before and after it, the part rests.
  const q = p.path, i = q.findIndex((r) => r.at <= d);
  const [a, c] = i === 0 ? [q[0], q[0]] : i === -1 ? [q.at(-1), q.at(-1)] : [q[i - 1], q[i]];
  const u = a === c ? 0 : (a.at - d) / (a.at - c.at), lift = lerp(a.lift, c.lift, u);
  return { s: p.s, x: p.x + lerp(a.dx, c.dx, u), h: lift + p.hh, hw: p.hw, hh: p.hh, hd: p.hd };
}

// --- editions and rows ----------------------------------------------------------------------------
// An edition: { name, describe, kinds, zones (its own, on top of KINDS and ZONES), mix (kind ->
// weight), two (share of rows taking two lanes), zone and rule ({ p, mix }: the chance a row has
// one, and which), gap ([min, max] metres to the next row, before rows tighten) }.
export const CLASSIC = { name: 'classic', describe: 'Walls, low blocks and bars.', mix: { wall: 0.5, low: 0.25, bar: 0.25 }, two: 0.45, gap: [42, 74] };

// Every part of a lane's obstacle on the track, wherever its path takes it.
function onTrack(parts) {
  return parts.every((p) => (p.path ?? [{ dx: 0 }]).every((q) => Math.abs(p.x + q.dx) + p.hw <= TRACK_W / 2 + 1e-9));
}
const fits = (kinds, kind, lane) => onTrack(partsOf(0, { [lane]: { kind, height: kinds[kind].height?.[0] } }, kinds));

export function checkEdition(e) {
  const bad = (why) => { throw new Error(`edition ${e?.name ?? ''}: ${why}`); };
  if (!EDITION.name.test(e?.name ?? '')) bad('a name of 1 to 40 letters, digits, spaces, dots, colons or dashes');
  if (e.describe !== undefined && (typeof e.describe !== 'string' || e.describe.length > EDITION.describe)) bad(`describe in at most ${EDITION.describe} characters`);
  for (const [field, base, check] of [['kinds', KINDS, checkKind], ['zones', ZONES, checkZone]]) {
    const own = Object.entries(e[field] ?? {});
    if (own.length > EDITION.own) bad(`at most ${EDITION.own} ${field} of its own`);
    for (const [name, spec] of own) {
      if (!EDITION.id.test(name) || base[name]) bad(`${field} ${name}: a new name, lowercase letters, digits and dashes`);
      check(name, spec);
    }
  }
  const kinds = { ...KINDS, ...e.kinds }, zones = { ...ZONES, ...e.zones };
  const mix = (m, names, what) => {
    const entries = Object.entries(m ?? {});
    if (!entries.length || entries.some(([n, w]) => !names[n] || !within(w, [0, 1000])) || !entries.some(([, w]) => w > 0)) bad(`${what}: weights for ${Object.keys(names).join(', ')}`);
  };
  mix(e.mix, kinds, 'mix');
  for (const kind of Object.keys(e.mix)) if (!LANES.some((l) => fits(kinds, kind, l))) bad(`${kind} fits no lane`);
  if (!within(e.two, EDITION.two)) bad(`two within ${EDITION.two}`);
  for (const [field, names] of [['zone', zones], ['rule', RULES]]) {
    if (e[field] === undefined) continue;
    if (!within(e[field].p, EDITION.p)) bad(`${field}.p within ${EDITION.p}`);
    mix(e[field].mix, names, `${field}.mix`);
  }
  if (!(Array.isArray(e.gap) && within(e.gap[0], EDITION.gap) && within(e.gap[1], EDITION.gap) && e.gap[0] <= e.gap[1])) bad(`gap [min, max] within ${EDITION.gap}`);
}
checkEdition(CLASSIC);

// The rows an edition makes: one or two lanes, each with a kind drawn from its mix (in a lane the
// kind fits), a zone and a rule by their chances, and the gap.
function pick(rng, mix) {
  const entries = Object.entries(mix).filter(([, w]) => w > 0);
  let roll = rng() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [name, w] of entries) if ((roll -= w) <= 0) return name;
  return entries.at(-1)[0];
}
export function editionMaker(e) {
  return ({ rng, tighten, run }) => {
    const lanes = {}, count = rng() < e.two ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const kind = pick(rng, e.mix), open = LANES.filter((l) => !lanes[l] && fits(run.kinds, kind, l));
      if (!open.length) continue;
      lanes[open[Math.floor(rng() * open.length)]] = { kind, height: run.kinds[kind].height && between(rng, ...run.kinds[kind].height) };
    }
    const row = { lanes, gap: between(rng, ...e.gap) * tighten };
    if (e.zone && rng() < e.zone.p) row.zone = pick(rng, e.zone.mix);
    if (e.rule && rng() < e.rule.p) row.rule = pick(rng, e.rule.mix);
    return row;
  };
}

// A track maker proposes each row: { lanes: { [lane]: { kind, height } }, zone, rule, gap }: one or
// two lanes taken, kinds from the run's kinds (height within the kind's range, where it has one),
// every part on the track wherever its path takes it, a zone and a rule or none, and gap (metres to
// the next row) within the edition bounds scaled by `tighten`. An edition's maker is
// editionMaker(edition); the arena takes others. A maker gets the row stream, where the row goes,
// how tight rows are there, and the run so far.
function checkProposal({ lanes, zone, rule, gap }, tighten, kinds, zones) {
  const taken = Object.keys(lanes ?? {});
  if (taken.length < 1 || taken.length > 2 || taken.some((l) => !LANES.includes(l))) throw new Error(`row: one or two of ${LANES.join(', ')}`);
  for (const [l, { kind, height }] of Object.entries(lanes)) {
    const k = kinds[kind];
    if (!k) throw new Error(`row: ${l} holds ${kind}, not one of ${Object.keys(kinds).join(', ')}`);
    if (k.height && !within(height, k.height)) throw new Error(`row: ${kind} height ${height} outside ${k.height}`);
  }
  if (!onTrack(partsOf(0, lanes, kinds))) throw new Error('row: a part leaves the track');
  if (zone !== undefined && !zones[zone]) throw new Error(`row: zone ${zone}, not one of ${Object.keys(zones).join(', ')}`);
  if (rule !== undefined && !RULES[rule]) throw new Error(`row: rule ${rule}, not one of ${Object.keys(RULES).join(', ')}`);
  const lo = EDITION.gap[0] * tighten, hi = EDITION.gap[1] * tighten;
  if (!(gap >= lo - 1e-9 && gap <= hi + 1e-9)) throw new Error(`row: gap ${gap} outside ${lo.toFixed(1)} to ${hi.toFixed(1)}`);
}

// The zone the hops is in, if any.
function zoneAt(world, b) {
  const { rows } = world, first = rows[0]?.id ?? 0;
  for (let i = Math.max(0, b.row - first - 2); i < rows.length; i++) {
    const r = rows[i];
    if (r.s - b.s > ZONE_REACH) break;
    if (r.zone && b.s >= r.s - r.zone.before && b.s <= r.s + r.zone.after) return r.zone;
  }
  return null;
}

// --- the hops ------------------------------------------------------------------------------------
// A hops is plain numbers, so the witness copies it freely. `row` and `pad` are the ids of the next
// row to clear and the next gate to fly through; `crossed` the lane it cleared the last row in.
const hops = () => ({ t: 0, s: START, speed: SPEED.start, boost: 0, x: 0, xv: 0, h: HOVER, hv: 0, lane: 1, airborne: false, hover: HOVER, duckT: 0, squash: 0, duckAmt: 0, sx: 1, sy: 1, sz: 1, charge: 0, row: 0, pad: 0, crossed: null });

function steer(b, move, world, events) {
  const before = b.lane;
  if ((move === 'left' || move === 'right') && zoneAt(world, b)?.mirror) move = move === 'left' ? 'right' : 'left';
  if (move === 'left') b.lane = Math.max(0, b.lane - 1);
  if (move === 'right') b.lane = Math.min(2, b.lane + 1);
  if (move === 'up' && !b.airborne) {
    events?.push({ type: 'jump', charge: b.charge });
    b.hv += JUMP * (1 + CHARGE.power * b.charge); b.airborne = true; b.squash = 0.3 + b.charge * 0.2;
    b.charge = 0;
  }
  if (move === 'down') { b.duckT = DUCK.time; b.squash = Math.max(b.squash, 0.2); }
  if (b.lane !== before) events?.push({ type: 'lane', from: before, to: b.lane });
}

// One step of flight, up to collisions: speed, the lateral spring, height under magnetic gravity
// (where the track curves away beneath the hops faster than gravity pulls, a crest, it lifts off;
// where it curves into it, a dip or a loop, it is pressed down), the body's squash, speed gates.
// A zone scales gravity and grip.
function move(b, world, events) {
  const dt = DT, zone = zoneAt(world, b), grip = zone?.grip ?? 1;
  b.t += dt;
  if (b.speed < SPEED.max && b.speed + SPEED.gain * dt >= SPEED.max) events?.push({ type: 'top' });
  b.speed = Math.min(SPEED.max, b.speed + SPEED.gain * dt);
  b.boost = Math.max(0, b.boost - BOOST.decay * dt);
  b.charge = Math.min(1, b.charge + CHARGE.perSecond * dt);
  const v = b.speed + b.boost;
  b.s += v * dt;
  b.xv += (((b.lane - 1) * LANE_X - b.x) * SPRING.k * grip - b.xv * SPRING.c * Math.sqrt(grip)) * dt;
  b.x += b.xv * dt;
  b.duckT = Math.max(0, b.duckT - dt);
  b.hover = lerp(b.hover, b.duckT > 0 ? DUCK.hover : HOVER, Math.min(1, dt * 18));
  b.hv += (-GRAVITY * (zone?.gravity ?? 1) - v * v * world.track.pitchAt(b.s)) * dt;
  b.h += b.hv * dt;
  if (b.h <= b.hover) {
    if (b.airborne && -b.hv > 4) { b.squash = Math.min(-b.hv / 25, 0.45); events?.push({ type: 'land', hv: b.hv }); }
    b.h = b.hover; b.hv = 0; b.airborne = false;
  } else if (b.h > b.hover + 0.3) b.airborne = true;
  b.squash = Math.max(0, b.squash - dt * 2.5);
  b.duckAmt = lerp(b.duckAmt, b.duckT > 0 ? 1 : 0, Math.min(1, dt * 18));
  b.sx = (1 + b.squash * 0.5) * (1 - DUCK.narrow * b.duckAmt);
  b.sy = (1 - b.squash) * (1 - DUCK.flat * b.duckAmt);
  b.sz = 1 + v / 700;
  const { pads } = world;
  for (let p = pads[b.pad - (pads[0]?.id ?? 0)]; p; p = pads[b.pad - pads[0].id]) {
    if (p.s < b.s - 1.2) { b.pad++; continue; } // flown past
    if (Math.abs(p.s - b.s) < 1.2 && Math.abs(b.x - (p.lane - 1) * LANE_X) < GATE_R && Math.abs(b.h - HOVER) < GATE_R) {
      b.boost = BOOST.kick; b.pad++;
      events?.push({ type: 'gate', pad: p });
    }
    break;
  }
}

// Collisions, after the step: touch and you crash, miss and you pass. The hops is an ellipsoid
// (squashed when it ducks or lands), each part its own box where it stands for this hops, posts
// included; the test is exact. A row's rule is checked as it is cleared. Returns the row and the
// index of the part hit, or the rule failed, if any.
function collide(b, world, events) {
  const { rows } = world, first = rows[0]?.id ?? 0;
  const cs = b.s - CENTRE, rx = HULL.x * b.sx, ry = HULL.y * b.sy, rz = HULL.z * b.sz;
  for (let i = b.row - first; i < rows.length; i++) {
    const r = rows[i];
    if (r.s - cs >= 4) break;
    if (Math.abs(r.s - cs) < 4) {
      for (let k = 0; k < r.parts.length; k++) {
        const u = boxAt(r.parts[k], r.s - b.s);
        const dz = (Math.max(u.s - u.hd, Math.min(cs, u.s + u.hd)) - cs) / rz;
        const dx = (Math.max(u.x - u.hw, Math.min(b.x, u.x + u.hw)) - b.x) / rx;
        const dy = (Math.max(u.h - u.hh, Math.min(b.h, u.h + u.hh)) - b.h) / ry;
        if (dx * dx + dy * dy + dz * dz < 1) return { row: r, part: k };
      }
    }
    if (i === b.row - first && cs - r.s > 1.2 + rz) {
      if (r.rule && !RULES[r.rule].ok(b)) return { row: r, rule: r.rule };
      b.row++; b.charge = Math.min(1, b.charge + CHARGE.perRow); b.crossed = laneOf(b);
      events?.push({ type: 'clear', row: r });
    }
  }
  return null;
}

// --- the witness ---------------------------------------------------------------------------------
// Hopses past every row so far, flown on through `row`. A pilot's choice comes every DECIDE steps:
// hold, a lane change, or (from LEAD seconds before the row, as a pilot's armed move fires) a jump
// or a duck. Hopses in the same state, to a tolerance, count once; at most WIDTH are kept, spread
// over lanes, air and jump charge. Every hops kept is one actually flown, so a row the witness
// passes can be passed.
const keyOf = (b) => [b.lane, Math.round(b.x / 0.3), Math.round(b.xv / 3), Math.round(b.h / 0.25), Math.round(b.hv / 2), b.airborne ? 1 : 0, Math.round(b.duckT / 0.12), Math.round(b.charge / 0.1), Math.round(b.boost / 5), Math.round(b.s), Math.round(b.speed / 2)].join(',');

function thin(list, width) {
  if (list.length <= width) return list;
  const groups = new Map();
  for (const b of list) {
    const k = `${b.lane}|${b.airborne}|${Math.floor(b.charge * 4)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  const queues = [...groups.values()], out = [];
  for (let i = 0; out.length < width; i++) for (const q of queues) if (i < q.length && out.length < width) out.push(q[i]);
  return out;
}

function choices(b, row) {
  const out = ['hold'];
  if (b.lane > 0) out.push('left');
  if (b.lane < 2) out.push('right');
  const ahead = row.s - b.s, v = Math.max(b.speed + b.boost, 1);
  if (ahead > 0 && !b.airborne && ahead / v <= LEAD.up) out.push('up');
  if (ahead > 0 && ahead / v <= LEAD.down) out.push('down');
  return out;
}

function witness(frontier, row, world, width) {
  let open = frontier;
  const past = new Map();
  while (open.length) {
    const next = new Map();
    for (const b of open) {
      for (const choice of choices(b, row)) {
        const c = { ...b };
        steer(c, choice, world);
        let alive = true;
        for (let k = 0; k < WITNESS.decide && c.row <= row.id; k++) {
          move(c, world);
          if (collide(c, world)) { alive = false; break; }
        }
        if (!alive) continue;
        const key = keyOf(c), into = c.row > row.id ? past : next;
        if (!into.has(key)) into.set(key, c);
      }
    }
    open = thin([...next.values()], width);
  }
  return thin([...past.values()], width);
}

// --- a run ---------------------------------------------------------------------------------------
// createRun({ seed, edition, maker }): the track exists at once; tick() flies one step. The
// edition (checked, CLASSIC by default) gives the kinds and zones on top of KINDS and ZONES, and the
// rows, unless a maker (the arena's) proposes them. The hops is flown by
// steer() (a key press) or decide() (a pilot's answer: jumps and ducks armed against the next row).
// What happens in a step (jump, land, lane, gate, clear, top speed reached, crash, a row or gate
// dropped behind) is
// pushed to run.events for the page to draw; it empties them. Rows are placed before they come into
// view: tick() places what the next AHEAD metres need, prepare(ms) places up to PLACE metres ahead
// within a time budget, so the witness's work is spread over frames. A row is the same whenever it
// is placed. run.inView() lists the rows and gates in view.
export function createRun({ seed, edition = CLASSIC, maker = null, width = WITNESS.width }) {
  checkEdition(edition);
  const kinds = { ...KINDS, ...edition.kinds }, zones = { ...ZONES, ...edition.zones };
  maker ??= editionMaker(edition);
  const track = createTrack(stream(seed, 1)), rowRng = stream(seed, 2), padRng = stream(seed, 3);
  const world = { track, rows: [], pads: [] };
  const events = [];
  const run = {
    seed, edition, track, kinds, zones, rows: world.rows, pads: world.pads, events,
    hops: hops(), crash: null, armed: null, pushed: 0, redrawn: 0,
    get distance() { return run.hops.s - START; },
    get flightMs() { return run.hops.t * 1000; },
  };
  let frontier = [hops()], nextRowAt = START + 110, nextPadAt = START + 200, rowId = 0, padId = 0;

  function placePads(upTo) {
    while (nextPadAt < upTo) {
      if (track.inLoop(nextPadAt)) { nextPadAt += 20; continue; }
      const pad = { id: padId++, s: nextPadAt, lane: Math.floor(padRng() * 3) };
      world.pads.push(pad);
      nextPadAt += between(padRng, PAD_GAP.min, PAD_GAP.max);
    }
  }

  function placeRow() {
    let rs = nextRowAt;
    const clearOfLoops = () => { while (track.inLoop(rs)) rs += 20; };
    clearOfLoops();
    for (let tries = 0; ; tries++) {
      if (tries === WITNESS.retries) {
        if (rs - nextRowAt > WITNESS.giveUp) throw new Error(`no passable row from ${nextRowAt.toFixed(0)} m to ${rs.toFixed(0)} m`);
        rs += WITNESS.push; clearOfLoops(); tries = 0; run.pushed++;
      }
      placePads(rs + 10); // the witness flies through the gates before the row
      // Rows close in with the distance flown when they come into view, AHEAD metres before them.
      const tighten = Math.max(TIGHTEN.floor, 1 - Math.max(0, rs - AHEAD - START) / TIGHTEN.over);
      const proposal = maker({ rng: rowRng, at: rs, tighten, run });
      checkProposal(proposal, tighten, kinds, zones);
      const zone = proposal.zone && { name: proposal.zone, ...zones[proposal.zone] };
      const row = { id: rowId, s: rs, lanes: Object.fromEntries(Object.entries(proposal.lanes).map(([l, { kind }]) => [l, kind])), parts: partsOf(rs, proposal.lanes, kinds), zone, rule: proposal.rule ?? null };
      world.rows.push(row);
      const past = witness(frontier, row, world, width);
      if (!past.length) { world.rows.pop(); run.redrawn++; continue; }
      frontier = past; rowId++;
      nextRowAt = rs + proposal.gap;
      return;
    }
  }

  run.steer = (choice) => { if (!run.crash) steer(run.hops, choice, world, events); };
  // A pilot's answer. A jump or a duck is armed against the next row and fires LEAD seconds before
  // it, so the hops tops its arc, or is lowest, as it crosses; a lane change applies at once.
  run.decide = (choice) => {
    const b = run.hops, next = inView(world.rows).find((r) => r.id >= b.row && r.s > b.s);
    if ((choice === 'up' || choice === 'down') && next) run.armed = { move: choice, row: next };
    else run.steer(choice);
  };
  const inView = (list) => list.filter((o) => o.s < run.hops.s + AHEAD);
  run.inView = () => ({ rows: inView(world.rows), pads: inView(world.pads) });
  run.zone = () => zoneAt(world, run.hops);
  // What a pilot is told: its lane, whether it is in the air, the zone it is in, the rows ahead in
  // view (their kinds by lane, their zone and rule, where each part stands now), and what each
  // kind, zone and rule named there is.
  run.view = () => {
    const b = run.hops, ahead = inView(world.rows).filter((r) => r.s > b.s + 0.8), here = zoneAt(world, b);
    const describe = {};
    for (const r of ahead) {
      for (const kind of Object.values(r.lanes)) describe[kind] = kinds[kind].describe;
      if (r.zone) describe[r.zone.name] = r.zone.describe;
      if (r.rule) describe[r.rule] = RULES[r.rule].describe;
    }
    if (here) describe[here.name] = here.describe;
    return {
      lane: LANES[b.lane],
      airborne: b.airborne,
      zone: here?.name ?? null,
      ahead: ahead.map((r) => ({
        distance: r.s - b.s,
        lanes: r.lanes,
        zone: r.zone?.name ?? null,
        rule: r.rule,
        parts: r.parts.map((p) => { const u = boxAt(p, r.s - b.s); return { kind: p.kind, x: u.x, bottom: u.h - u.hh, top: u.h + u.hh, width: u.hw * 2 }; }),
      })),
      describe,
    };
  };
  run.prepare = (ms) => {
    const until = performance.now() + ms;
    while (nextRowAt < run.hops.s + PLACE && performance.now() < until) placeRow();
  };
  run.tick = () => {
    if (run.crash) return;
    const b = run.hops;
    while (nextRowAt < b.s + AHEAD) placeRow();
    placePads(b.s + AHEAD);
    move(b, world, events);
    if (run.armed) {
      const { move: armed, row } = run.armed;
      if (b.row > row.id) run.armed = null;
      else if ((row.s - b.s) / Math.max(b.speed + b.boost, 1) <= LEAD[armed]) { run.armed = null; steer(b, armed, world, events); }
    }
    run.crash = collide(b, world, events);
    if (run.crash) events.push({ type: 'crash', ...run.crash });
    while (world.rows.length && b.s - world.rows[0].s > BEHIND && world.rows[0].id < b.row) events.push({ type: 'drop', row: world.rows.shift() });
    while (world.pads.length && b.s - world.pads[0].s > BEHIND) events.push({ type: 'unpad', pad: world.pads.shift() });
  };
  return run;
}
