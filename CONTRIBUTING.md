# Contributing

Bots and track makers come in by pull request. One bot or one maker per pull request, titled `bots: <name>` or `makers: <name>`.

## Bots

A bot is one file, `bots/<name>/pilot.js`: plain browser JavaScript, no dependencies, no build step, at most 100 KB. `<name>` is lowercase letters, digits and dashes.

It defines `window.hopsRunDecide(request)` and answers `{ pilot, model, moves, probabilities, forwardMs }`:

| Field | Meaning |
| --- | --- |
| `pilot` | The name it flies under |
| `model` | What decides: `hand-written`, or the model that wrote it |
| `moves` | Moves on offer, from `left`, `right`, `hold`, `up`, `down` |
| `probabilities` | One per move; the most likely is flown |
| `forwardMs` | Milliseconds the decision took |

The request is `{ lane, airborne, zone, ahead, describe }`, documented in [`arena/README.md`](arena/README.md#what-pilots-see). A bot decides from the request only:

- No reading or changing the page, the game's code or its state. A bot sets `window.hopsRunDecide`, and may keep its own state on `window.__pilotState` for debugging; nothing else of the page's.
- No network, no storage, no `Math.random`, no `Date`. Time comes from `performance.now()`, which the arena runs on the run's own clock.
- An answer within 5 ms at the median in the arena (`forwardMs`): the page asks every frame.

The pull request adds a row to the table in [`bots/README.md`](bots/README.md) and pastes the output of:

```bash
node arena/arena.js --pilots <name> --runs 30
node arena/arena.js --pilots <name> --maker odd --runs 30
```

Bots are ranked in the arena, over the same seeds as every other pilot. A bot's runs are not posted through the players' form on [game.hopsworks.ai](https://game.hopsworks.ai): the players' board is for people flying by hand, and a bot's runs found there are removed.

## Track makers

A maker is `arena/makers/<name>.js`, written to the contract in [`arena/README.md`](arena/README.md#writing-a-track-maker): a default export that proposes each row, and optionally `kinds` and `zones` of its own.

- Every draw comes from the `rng` it is given, so a seed replays.
- Kinds and zones stay within the bounds and carry a `describe` for the pilots.
- No network, no storage, no reading the pilot's code.

The pull request pastes the arena's output for every bot in [`bots/`](bots) on the new maker and on `procedural`.

Maker code runs in the arena only. Kinds and zones are data; ones that make it into the game are added to `game/public/sim.js` in their own pull request.

## Licence

Contributions are under the repository's [MIT licence](LICENSE).
