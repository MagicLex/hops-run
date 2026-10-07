// Flies a bot on game.hopsworks.ai from the browser console, through the game's own pilot hook.
//
// 1. Open https://game.hopsworks.ai, open the console, paste the bot's pilot.js (it defines
//    window.jevworksDecide).
// 2. Paste this file. It reloads the page in place with the pilot steering, flies run after run,
//    and posts a run through the public form once it beats BEAT metres (set SUBMIT to false to
//    only fly). Runs stay on the human path: the server times each one from its run key.
//
// The game normally runs on requestAnimationFrame, which Chrome pauses in a background tab. The
// loop below steps the game at a fixed 60 fps clock that catches up to real time, one frame per
// task, so the tab can stay in the background.
const NAME = 'claude-fable-bot', BEAT = 12381, SUBMIT = true;

if (typeof window.jevworksDecide !== 'function') throw new Error('paste the pilot first: window.jevworksDecide is missing');
const [html, game] = await Promise.all([fetch('/', { cache: 'no-store' }).then((r) => r.text()), fetch('/game.js', { cache: 'no-store' }).then((r) => r.text())]);
const patches = [
  // the pilot steers, but the run is posted like a player's, not with a pilot token
  ["const PILOT = typeof window.jevworksDecide === 'function';", "const PILOT = false; const DRIVE = typeof window.jevworksDecide === 'function';"],
  ['const analytics = (event, data) => { if (!PILOT) window.umami?.track(event, data); };', 'const analytics = () => {};'],
  ['    if (PILOT) ask();', '    if (DRIVE) ask();'],
];
let patched = game;
for (const [from, to] of patches) {
  if (!patched.includes(from)) throw new Error(`game.js changed, patch missing: ${from}`);
  patched = patched.replace(from, to);
}
patched = patched.replaceAll('requestAnimationFrame(', 'window.__frame(');

// Fixed-step frame loop, independent of tab visibility.
const realNow = performance.now.bind(performance);
let synth = realNow(), queue = [], chained = false;
performance.now = () => synth;
const channel = new MessageChannel();
const runOne = () => {
  if (!queue.length || synth + 1000 / 60 > realNow()) { chained = false; return; }
  synth += 1000 / 60;
  queue.shift()(synth);
  chained = true;
  channel.port2.postMessage(0); // the next frame in a new task, so the pilot's answer lands in between
};
channel.port1.onmessage = runOne;
const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 8)'], { type: 'text/javascript' })));
ticker.onmessage = () => { if (!chained) runOne(); };
window.__frame = (cb) => { queue.push(cb); return 0; };

const page = html
  .replace(/<script defer src="https:\/\/analytics\.hops\.io[^>]*><\/script>/, '')
  .replace(/https:\/\/www\.youtube-nocookie\.com\/embed\/[^"]*/, 'about:blank')
  .replace('<script type="module" src="game.js"></script>', `<script type="module">${patched.replace(/<\/script/g, '<\\/script')}<\/script>`);
if (!page.includes('DRIVE')) throw new Error('page rewrite failed');
document.open(); document.write(page); document.close();

// Fly again after each crash; post once when a run beats BEAT.
window.bot = { runs: [], posted: null };
const press = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
let crashedAt = 0;
setInterval(() => {
  const crash = document.querySelector('.label.crash')?.textContent.match(/Crashed at (\d+) m/);
  if (window.bot.posted) return;
  if (!crash) { crashedAt = 0; if (!document.body.classList.contains('flying')) press(); return; }
  const distance = +crash[1];
  if (!crashedAt) { crashedAt = Date.now(); window.bot.runs.push(distance); return; }
  if (Date.now() - crashedAt < 1500) return;
  if (SUBMIT && distance > BEAT) {
    document.getElementById('name').value = NAME;
    document.getElementById('sign').requestSubmit();
    window.bot.posted = { distance, at: new Date().toISOString() };
    return;
  }
  document.activeElement?.blur(); crashedAt = 0; press();
}, 250);
