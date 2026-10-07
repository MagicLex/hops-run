// odd: the game's own mix, with the moving kinds and the zones mixed in. A third of the rows hold
// a sweeper (alone, from the left lane) or a dropbar in place of an obstacle; a fifth sit in a zone.
import { procedural, ZONES } from '../../game/public/sim.js';

export default function odd(ctx) {
  const { rng } = ctx, row = procedural(ctx);
  if (rng() < 0.33) {
    if (rng() < 0.5) row.lanes = { left: { kind: 'sweeper' } };
    else row.lanes[Object.keys(row.lanes)[0]] = { kind: 'dropbar' };
  }
  if (rng() < 0.2) {
    const names = Object.keys(ZONES);
    row.zone = names[Math.floor(rng() * names.length)];
  }
  return row;
}
