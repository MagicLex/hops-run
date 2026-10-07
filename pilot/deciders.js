// The model pilots' deciders, shared by the runner (runner.js) and the arena (../arena): each
// turns what the game tells a pilot ({ lane, airborne, ahead }) into move probabilities.
import { readFileSync } from 'node:fs';

// Decider -> the pilot it flies as, the settings it needs, and whether it is a Hopsworks
// deployment (authenticated with HOPSWORKS_API_KEY, or the App's own JWT).
export const DECIDERS = {
  semif: { pilot: 'qwen', needs: ['semifUrl'], hopsworks: true },
  jev: { pilot: 'jev', needs: ['jevUrl', 'jevModel', 'jevKey'] },
  kumo: { pilot: 'kumo', needs: ['kumoUrl'], hopsworks: true },
  clef: { pilot: 'clef', needs: ['clefUrl'], hopsworks: true },
};

// --- decisions -----------------------------------------------------------------------------------
// The prompt is the one measured with eval/decide.py on the jev-pilot tag: the facts sit in the
// options (what each move leads into), so the model judges each move's consequence.
const LANES = ['left', 'centre', 'right'];
const HAS = { wall: 'a wall', low: 'a low block', bar: 'a bar', undefined: 'nothing, it is open' };
const RULES = 'The hops crashes if it hits a wall: jumping or ducking never clears a wall, only moving to another lane does. Jumping clears a low block or a bar. Ducking clears a bar. Flying straight is only safe in an open lane.';
function row({ lane, airborne, ahead }) {
  const next = ahead[0], i = LANES.indexOf(lane), lanes = next?.lanes ?? {}, here = HAS[lanes[lane]];
  const options = [];
  for (const [id, j] of [['left', i - 1], ['right', i + 1]]) {
    if (j >= 0 && j < 3) options.push({ id, description: `Move to the ${LANES[j]} lane, which has ${HAS[lanes[LANES[j]]]}` });
  }
  options.push({ id: 'hold', description: `Stay in the ${lane} lane, which has ${here}, and fly straight` });
  if (!airborne) options.push({ id: 'up', description: `Stay in the ${lane} lane, which has ${here}, and jump` });
  options.push({ id: 'down', description: `Stay in the ${lane} lane, which has ${here}, and duck` });
  const where = next ? `The next row of obstacles is ${Math.round(next.distance)} m ahead.` : 'There are no obstacles ahead.';
  return { id: 'hops', state: `${RULES} The hops is in the ${lane} lane${airborne ? ', in the air' : ''}. ${where}`, question: 'What should the hops do?', options };
}

// cfg: { semifUrl, kumoUrl, clefUrl, jevUrl, jevModel, jevKey, apiKey, jwt } as each decider needs.
export function createDeciders(cfg) {
  // The platform rotates the pod's JWT: read it per call.
  const auth = () => (cfg.apiKey ? `ApiKey ${cfg.apiKey}` : `Bearer ${readFileSync(cfg.jwt, 'utf8').trim()}`);

  // A Hopsworks deployment answers with option ids, probabilities and its forward time: semif reads
  // the decision as text (row), Kumo Tabular as the game state itself.
  async function decideServed(name, url, input) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [input] }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 200)}`);
    const [p] = JSON.parse(text).predictions;
    return { moves: p.option_ids, probabilities: p.probabilities, forwardMs: p.forward_seconds * 1000, model: String(p.model.revision ?? '').replace(/^hopsworks:/, '') };
  }

  // Jev and Clef answer the same decision as one SystemOne Choice question: the options are the
  // criteria. Jev is TypeSafe's API; Clef is a Hopsworks deployment (clef/ in this repo) answering the same
  // request body, with its forward time. Jev reports none, so its round trip stands in.
  function choiceRequest(state, model) {
    const { state: text, question, options } = row(state);
    return { moves: options.map((o) => o.id), body: { model, state: text, questions: { move: { type: 'choice', instructions: question, criteria: Object.fromEntries(options.map((o) => [o.id, o.description])) } } } };
  }
  async function decideJev(state) {
    const { moves, body: request } = choiceRequest(state, cfg.jevModel), t0 = performance.now();
    const res = await fetch(cfg.jevUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.jevKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`jev: HTTP ${res.status} ${body.slice(0, 200)}`);
    const d = JSON.parse(body);
    return { moves, probabilities: moves.map((m) => d.answers.move.probabilities[m] ?? 0), forwardMs: performance.now() - t0, model: d.model };
  }
  async function decideClef(state) {
    const { moves, body: request } = choiceRequest(state, 'clef-flash');
    const res = await fetch(cfg.clefUrl, {
      method: 'POST',
      headers: { Authorization: auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [request] }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`clef: HTTP ${res.status} ${body.slice(0, 200)}`);
    const [d] = JSON.parse(body).predictions;
    return { moves, probabilities: moves.map((m) => d.answers.move.probabilities[m] ?? 0), forwardMs: d.forward_seconds * 1000, model: String(d.model ?? '').replace(/^hopsworks:/, '') };
  }
  return {
    semif: (state) => decideServed('semif', cfg.semifUrl, row(state)),
    kumo: (state) => decideServed('kumo', cfg.kumoUrl, state),
    jev: decideJev,
    clef: decideClef,
  };
}
