# Arena

Pilots fly Hops Run headless on the game's simulation ([`game/public/sim.js`](../game/public/sim.js)), each over the same seeds, on an edition of the game or against a track maker.

```bash
(cd game && npm ci)
node arena/arena.js --pilots claude-bot,claude-fable-bot --edition odd --runs 30
```

| Flag | Meaning |
| --- | --- |
| `--pilots` | Comma-separated: bots from [`bots/`](../bots), deciders `semif`, `kumo`, `jev`, `clef` |
| `--edition` | `classic` (the game's own, default) or a file in [`editions/`](editions) |
| `--maker` | A track maker from [`makers/`](makers), in place of an edition |
| `--runs` | Seeds per pilot, default 30 |
| `--seed` | First seed, default 1 |
| `--max` | Distance a run stops at, default 100,000 m |
| `--json` | Every run, as JSON, with what ended it |

The table gives each pilot's median, mean, 90th percentile and best, and what its runs crashed on: a kind of obstacle, or a rule.

Deciders read the settings of [`pilot/`](../pilot): `SEMIF_URL`, `KUMO_URL`, `CLEF_URL`, `JEV_URL`, `JEV_MODEL`, `TYPESAFE_API_KEY`, `HOPSWORKS_API_KEY`. A pilot is asked as the page asks it, at most once per 60 Hz frame, and its answer lands once its round trip has passed in run time.

## Editions

An edition is what a track holds, as data: which kinds of obstacle, zones and rules, and how often each comes. The game plays `classic`; a designer publishes others.

```json
{
  "name": "odd",
  "describe": "The classic mix with sliding walls, falling bars, zones and rules.",
  "mix": { "wall": 0.35, "low": 0.2, "bar": 0.15, "sweeper": 0.15, "dropbar": 0.15 },
  "two": 0.4,
  "zone": { "p": 0.2, "mix": { "drift": 1, "float": 1, "mirror": 1 } },
  "rule": { "p": 0.1, "mix": { "bounce": 1, "hold": 1, "air": 1, "duck": 1 } },
  "gap": [42, 74]
}
```

| Field | Meaning |
| --- | --- |
| `name` | 1 to 40 letters, digits, spaces, dots, colons or dashes |
| `describe` | What it is, in at most 300 characters |
| `kinds`, `zones` | Up to 8 each of its own, on top of the game's, with new names |
| `mix` | Kind to weight: how often each kind fills a lane. Each kind has to fit at least one lane |
| `two` | Share of rows taking two lanes, 0 to 0.8 |
| `zone`, `rule` | `{ p, mix }`: the chance a row has one (0 to 0.5) and which, by weight |
| `gap` | `[min, max]` metres to the next row, within 30 to 90, before rows tighten (to 0.55 times, 2,250 m into a run) |

Each row draws one or two lanes, a kind for each from `mix` (in a lane where the kind fits), a height within the kind's range, a zone and a rule by their chances, and the gap.

**Every row is passable.** Before a row is placed, a witness flies through it: hopses searched through the game's physics with the moves a model pilot has, each already past every earlier row, keeping to every rule. A row the witness cannot pass is not placed and is drawn again. After 12 refusals the row moves 10 m down the track, and a run stops with an error once a row has moved 400 m.

## Track makers

A maker is code, `makers/<name>.js`, run in the arena only: its default export proposes each row, and it may export `kinds` and `zones` of its own. Use one to try what an edition cannot say, such as rows that answer the pilot.

```js
export default function maker({ rng, at, tighten, run }) {
  return { lanes: { left: { kind: 'wall', height: 5 } }, zone: 'float', rule: 'bounce', gap: 50 * tighten };
}
export const kinds = { /* name: kind */ };
export const zones = { /* name: zone */ };
```

The maker gets:

| Field | Meaning |
| --- | --- |
| `rng()` | The run's row stream, a number in [0, 1). Draw from it, never from `Math.random`, so a seed replays |
| `at` | Metres along the track where the row goes |
| `tighten` | How tight rows are there: 1 up to `at` 382 m, falling to 0.55 at 2,632 m |
| `run` | The run so far: `run.hops` (the pilot's hops), `run.rows`, `run.view()` (what the pilot is told), `run.kinds`, `run.zones` |

It returns:

| Field | Rule |
| --- | --- |
| `lanes` | One or two of `left`, `centre`, `right`, each `{ kind, height }`. `height` only for a kind with a `height` range, within it |
| `zone` | A zone name, or nothing |
| `rule` | A rule name, or nothing |
| `gap` | Metres to the next row, within 30 to 90 times `tighten` |

Every part has to stay on the track wherever its path takes it. A proposal that breaks a rule throws, and the run fails. The witness holds a maker's rows as it holds an edition's; a maker that always proposes the same impossible row ends the run.

## Kinds

A kind is data: boxes (parts) set in the lane it stands in.

```js
sweeper: {
  describe: 'a wall that slides two lanes to the right while the hops comes from 80 m to 20 m away',
  parts: [{ w: 2.2, h: 4.6, d: 1.6, path: [{ at: 80, lane: 0 }, { at: 20, lane: 2 }] }],
}
```

| Field | Meaning |
| --- | --- |
| `describe` | What the pilots are told it is. Required |
| `height` | `[min, max]`: the range a row picks its height from, for parts with `h: 'height'` |
| `parts[].w`, `h`, `d` | Width across, height, depth along the track, in metres |
| `parts[].x` | Metres across from the lane's centre, default 0 |
| `parts[].lift` | Metres from the track to its bottom, default 0 |
| `parts[].post` | A thin support: drawn in ink, never painted on a clear or a crash |
| `parts[].path` | 2 to 4 points `{ at, lane, lift }`: where the part is when the hops is `at` metres from the row, `lane` lanes across from where it stands, its bottom at `lift`. Linear in between; before the first and after the last, the part rests |

A path is keyed on each hops' own distance to the row, so the pilot's hops and every hops the witness flies see the part move with their own approach.

The game's kinds are `wall`, `low`, `bar`, `sweeper` and `dropbar` (`KINDS` in `sim.js`).

## Zones

A zone changes how the hops flies over a stretch of track around its row.

```js
float: { describe: 'a float zone: gravity is halved, so jumps fly higher and longer', gravity: 0.5, before: 80, after: 10, tint: 'green' },
```

| Field | Meaning |
| --- | --- |
| `describe` | What the pilots are told it is. Required |
| `gravity` | Gravity scale |
| `grip` | Lateral spring scale: below 1, lane changes are slow and sway |
| `mirror` | `true`: left moves the hops right and right moves it left |
| `before`, `after` | Metres of track it covers ahead of its row and past it |
| `tint` | `ink`, `green` or `rust`: how the page draws it |

The game's zones are `drift`, `float` and `mirror` (`ZONES` in `sim.js`).

## Rules

A rule is checked as the hops clears its row; a rule broken counts as a crash. The vocabulary is fixed (`RULES` in `sim.js`):

| Rule | Clear the row |
| --- | --- |
| `bounce` | In a different lane from the row before |
| `hold` | In the same lane as the row before |
| `air` | In the air |
| `duck` | Ducking |

## Bounds

| What | Bound |
| --- | --- |
| Part `w` | 0.1 to 2.5 m |
| Part `h`, `height` | 0.1 to 6 m |
| Part `d` | 0.1 to 3 m |
| Part `lift`, path `lift` | 0 to 5 m |
| Part `x` | within its lane, -1.3 to 1.3 m |
| Path `at` | 0 to 360 m |
| Path `lane` | -2 to 2 |
| Zone `gravity`, `grip` | 0.4 to 1.6 |
| Zone `before` | 0 to 120 m |
| Zone `after` | 0 to 40 m |

## What pilots see

`run.view()`, the request every pilot gets:

```json
{
  "lane": "centre", "airborne": false, "zone": "mirror",
  "ahead": [{ "distance": 71.1, "lanes": { "left": "sweeper" }, "zone": null, "rule": "bounce",
              "parts": [{ "kind": "sweeper", "x": -1.83, "bottom": 0, "top": 4.6, "width": 2.2 }] }],
  "describe": { "sweeper": "a wall that slides two lanes to the right ...", "mirror": "a mirror zone: ...", "bounce": "a bounce rule: ..." }
}
```

`parts` is where each part stands now, for this hops. The text deciders put `describe` into their prompt.

## Editions here

| Edition | Rows |
| --- | --- |
| `classic` | The game's: walls, low blocks and bars |
| [`odd`](editions/odd.json) | The classic mix with sweepers and dropbars; a fifth of the rows sit in a zone, a tenth carry a rule |

The two bots over seeds 1 to 30:

| Pilot | `classic` median | `odd` median | What ended their `odd` runs |
| --- | --- | --- | --- |
| claude-fable-bot | 6,967 m | 293 m | sweeper 11, duck rule 6, air rule 4, bounce rule 4, hold rule 2, wall 2, dropbar 1 |
| claude-bot | 5,964 m | 337 m | sweeper 18, duck rule 4, bounce rule 4, air rule 1, hold rule 1, wall 1, dropbar 1 |

Both bots were written against walls, low blocks and bars and read nothing else; on `odd` they fly into sweepers, zones and rules they do not read.

Maker code runs in the arena only. Editions, kinds and zones are data: the game plays an edition once the server publishes it, and a kind or zone joins the game's own once it is added to `sim.js`.
