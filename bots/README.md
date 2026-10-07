# bots

Two Hops Run pilots written by Claude models, each of which took first place on the live board at [game.hopsworks.ai](https://game.hopsworks.ai) on 6 and 7 October 2026.

| Bot | Written by | Live best | Folder |
| --- | --- | --- | --- |
| `claude-bot` | Claude Opus 5.5 | 12,381 m (5 live runs) | [`claude-bot/`](claude-bot) |
| `claude-fable-bot` | Claude Fable 5.1 | 30,400 m (49 live runs) | [`claude-fable-bot/`](claude-fable-bot) |

Both are hand-written planners, not model inference: each Claude read `game.js`, worked out the physics, and wrote a decision function. They answer the same request the `qwen` and `kumo` pilots get, `hopsRunDecide({ lane, airborne, ahead })`, and use nothing else from the game. So they are a different kind of entry from the models in this repo: a model that is told the rules in English against a program that knows the physics.

## How they decide

The game calls `hopsRunDecide` every frame with the lane, whether the hops is airborne, and the rows ahead with their distance and what each lane holds. The pilot answers with a probability per move (`left`, `right`, `hold`, `up`, `down`); the game flies the most likely one, arming jumps and ducks against the next row.

**`claude-bot`** estimates speed from how fast the nearest row closes, then searches the next 5 rows for the cheapest surviving sequence of lanes, jumps and ducks. It knows that jump height depends on the jump charge (which fills over time and with each row cleared), so a charged jump clears a wall, which the model pilots are told is impossible. It flies the first step of the best plan and re-plans next frame.

**`claude-fable-bot`** keeps the same shape and models more of the game:

- It plans up to 12 rows ahead (a full-charge jump flies over about ten), with memoised search.
- Lane changes follow the game's lateral spring: a change can start before the previous row passes if the lanes it enters are clear, and the hull is exposed to both lanes while it is under way.
- Jumps fire when the game fires them (0.3 s before the row, or on landing), and the trajectory, the landing time and the charge are tracked through the plan. Take-off and landing squash the hops and widen its hull, which keeps a lane just left within reach a little longer.
- A duck lowers the hover; the game counts the hops airborne while it drops, and a ducked hops passes a bar only between the bar's posts, so not while changing lane.
- Hills change the pull towards the track by up to four times, which the pilot cannot see. A jump that ends early (a dip) or a lift-off that is not a jump (a crest) marks the next second as hilly: jumps and ducks are trusted less and lane changes preferred. Lane changes are the cheapest move throughout, because hills cannot spoil them.

## Results

Local runs are the game served from a local copy with the frame clock sped up, so a few hundred runs take minutes. They are the same game code at 60 fps steps; only the clock is faster.

| Bot | Local runs | Median | 90th percentile | Best | Runs over 9,000 m |
| --- | --- | --- | --- | --- | --- |
| `claude-bot` | 97 | 4,274 m | 8,530 m | 12,817 m | 9 (9%) |
| `claude-fable-bot` | 53 | 7,081 m | 13,105 m | 21,811 m | 16 (30%), of which 8 (15%) over 12,381 m |

For comparison the README's figures for the model pilots on game v1.11.0: `kumo` median 2,188 m, best 5,994 m; `qwen` median 1,018 m, best 6,330 m.

Live runs, in order:

- `claude-bot`: 3,217 · 3,204 · 6,403 · 3,501 · **12,381**
- `claude-fable-bot`, 6 October, one instance: 5,298 · 2,332 · 6,416 · 5,901 · 3,398 · 8,111 · 6,420 · 7,383 · 4,672 · 2,312 · 9,468 · 6,724 · 7,979 · 10,441 · 7,081 · 6,472 · 5,155 · 2,892 · 4,221 · 3,547 · 1,975 · 6,691 · 8,794 · 8,695 · 956 · **20,528**
- `claude-fable-bot`, 7 October, four instances flying at once with the same code: 6,654 · 7,217 · 3,612 · 8,185 · 3,774 · 5,851 · 7,240 · 2,845 · 5,611 · 12,111 · 6,377 · 6,101 · 8,654 · 4,842 · 8,820 · 5,806 · 6,202 · 7,597 · 5,917 · 7,405 · 6,550 · 2,969 · **30,400**

Over the 49 live runs the median is 6,377 m and 4 runs (8%) passed 12,381 m, in line with the local batch. The two records are the tail: a run that long is roughly a 1-in-25 to 1-in-50 event for this pilot, so it is a matter of flying enough runs, which is what the four instances were for.

Two things cost `claude-fable-bot` runs live that the local harness did not show. Chrome pauses `requestAnimationFrame` in a background tab, which froze the game, and when a tab is visible but not focused it can drop to 30 fps, which makes jump timing coarser; `run-in-browser.js` steps the game on its own fixed clock so neither matters. The other is hills: the first version ducked under bars on crests and clipped them, and jumped in dips and fell short.

## Running them

**As a pilot, through the runner.** Each `pilot.js` sets `window.hopsRunDecide` and answers `{ pilot, model, moves, probabilities, forwardMs }`, the same contract the runner expects from the model pilots. Load it before `game.js` and the game flies it as a pilot, with its runs posted under the pilot's token.

**From the browser, as a player.** Open the game, paste `pilot.js` into the console, then paste [`run-in-browser.js`](run-in-browser.js). It reloads the page with the pilot steering and flies run after run; set `NAME`, `BEAT` and `SUBMIT` at the top. Several tabs can fly at once, and they share the best posted so far through localStorage, so only a run that beats every other tab's is posted. Runs go through the public form, timed by the server from each run's key, so they appear as a player's. The live scores above were posted this way, as `manu claude-bot`, `claude-fable-bot` and `manu claude-fablebot` (the form allows 20 characters), so they are labelled as bots on the players' board.

The pilots answer in well under a millisecond.
