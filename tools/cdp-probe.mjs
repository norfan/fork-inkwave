// CDP probe v2: dump state to dist/probe-state.json + screenshot dist/4p-shot.png
const port = process.argv[2] || 9222;
const fs = await import('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = 'F:/Workspace/Trea/mijin/fork-inkwave/dist/probe-state.json';

let targets = null;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    targets = await res.json();
    if (targets.length) break;
  } catch { /* not up yet */ }
  await sleep(1000);
}
if (!targets || !targets.length) { fs.writeFileSync(OUT, JSON.stringify({ error: 'no targets' })); process.exit(1); }
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
await new Promise((r) => { ws.onopen = r; });

const expr = process.argv[3] ? process.argv[3] : `(() => {
  const g = window.__inkwave, G = window.__G;
  if (!g || !G) return { booted: false };
  const m = g.match;
  return {
    booted: true,
    mode: G.mode,
    matchState: m ? m.state : null,
    matchPaused: m ? m.paused : null,
    local4P: !!g.R.local4P,
    quads: g.R.quads ? g.R.quads.length : 0,
    overlayQuads: document.querySelectorAll('.iw4p-quad').length,
    localPlayers: m && m.localPlayers ? m.localPlayers.map(p => ({ name: p.actor.name, team: p.actor.team, alive: p.actor.alive, ctl: !!p.controller, pad: !!(p.input && p.input.padIndex !== undefined && p.input.padIndex) })) : [],
    localActors: m ? m.actors.filter(a => a.isLocal).map(a => a.name) : [],
    totalActors: m ? m.actors.length : 0,
    controllers: m ? m.controllers.length : 0,
    rigs: g.localRigs ? g.localRigs.length : 0,
    inputs: g.localInputs ? g.localInputs.length : 0,
    fps: g.fps,
    canvas: g.R.renderer.domElement.width + 'x' + g.R.renderer.domElement.height,
    cameraAspects: g.localRigs ? g.localRigs.map(r => r.camera.aspect.toFixed(3)) : [],
  };
})()`;
const rt = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const state = rt.exceptionDetails
  ? { exception: JSON.stringify(rt.exceptionDetails).slice(0, 800) }
  : (rt.result && rt.result.value !== undefined ? rt.result.value : { raw: JSON.stringify(rt).slice(0, 800) });
fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
console.log('PROBE: wrote', OUT);

if (process.argv[3]) { ws.close(); process.exit(0); }

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
if (shot && shot.result && shot.result.data) {
  fs.writeFileSync('F:/Workspace/Trea/mijin/fork-inkwave/dist/4p-shot.png', Buffer.from(shot.result.data, 'base64'));
  console.log('PROBE: screenshot saved');
} else {
  console.log('PROBE: screenshot failed', JSON.stringify(shot).slice(0, 300));
}
ws.close();
process.exit(0);
