// Pad E2E: drive the desktop app's pairing screen over CDP, join with a simulated phone
// (native WebSocket), verify seat assignment and that padinput reaches the game's virtual pad.
const port = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const m = ++id; pending.set(m, res); ws.send(JSON.stringify({ id: m, method, params })); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
const evl = async (expression) => {
  const rt = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (rt.exceptionDetails) return { exc: (rt.exceptionDetails.exception && rt.exceptionDetails.exception.description || rt.exceptionDetails.text).slice(0, 300) };
  return rt.result && rt.result.result && rt.result.result.value;
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  if (s.result && s.result.data) { await import('node:fs').then((fs) => fs.writeFileSync('F:/Workspace/Trea/mijin/fork-inkwave/dist/' + name + '.png', Buffer.from(s.result.data, 'base64'))); }
};
const out = {};

// A. confirm the PLAY screen exposes the PHONE PAD button, then open the pairing screen
await evl(`(window.__inkwave).menus.show('mode')`);
await sleep(700);
out.playBtn = await evl(`(function () { const b = document.querySelector('.iw-modesel__padbtn'); return b ? b.textContent.trim() : null; })()`);
await evl(`(window.__inkwave).menus._go('pad')`);
await sleep(900);
let scr = await evl(`document.querySelector('.iw-screen') && document.querySelector('.iw-screen').className`);
out.afterPad = scr;
out.pairing = await evl(`JSON.stringify({
  code: (document.querySelector('.iw-pad__code') || {}).textContent,
  addrs: [...document.querySelectorAll('.iw-pad__addrline')].map((x) => x.textContent),
  slots: [...document.querySelectorAll('.iw-pad__slotname')].map((x) => x.textContent),
  status: (document.querySelector('.iw-pad__status') || {}).textContent,
})`);

// B. simulated phone joins the room shown on screen
const code = await evl(`(window.__inkwave).padCode`);
const pws = new WebSocket(`ws://127.0.0.1:13000/room/${code}?name=Pixel&v=1`);
const device = 'sim-e2e';
let seatMsg = '';
pws.onmessage = (ev) => { const s = String(ev.data); if (s.includes('padseat')) seatMsg = s; };
await new Promise((r) => { pws.onopen = r; });
pws.send('b|' + JSON.stringify({ t: 'padjoin', device, name: 'Pixel' }));
await sleep(900);
out.afterJoin = await evl(`JSON.stringify({
  devs: [...((window.__inkwave).padDevices || new Map()).entries()].map(([k, v]) => [k, v.slot, v.name]),
  slots: [...document.querySelectorAll('.iw-pad__slotname')].map((x) => x.textContent),
  seat: ${JSON.stringify(seatMsg)},
})`);
await shot('pad-pairing');

// C. stream input, check the seat's virtual pad reflects it
pws.send('b|' + JSON.stringify({ t: 'padinput', device, d: { lx: 0.4, ly: -0.3, rx: 0.8, ry: 0.1, fire: 1, squid: 0, jump: 0, sub: 0, special: 0, map: 0 } }));
await sleep(400);
out.virtual = await evl(`JSON.stringify({
  cached: ((window.__inkwave).padLast.get(${JSON.stringify(device)}) || null),
  input0: (window.__inkwave).input ? (window.__inkwave).input.virtual || null : null,
})`);

// D. build 2-player local rigs and re-check the phone is re-seated into P2
await evl(`(window.__inkwave)._beginLocal4P(2)`);
await sleep(500);
pws.send('b|' + JSON.stringify({ t: 'padinput', device, d: { lx: 0.9, ly: 0.0, rx: -0.6, ry: 0.4, fire: 1, squid: 1, jump: 0, sub: 0, special: 0, map: 0 } }));
await sleep(400);
out.p2virtual = await evl(`JSON.stringify({
  p2: (window.__inkwave).localInputs[1] ? (window.__inkwave).localInputs[1].virtual || null : null,
  rigs: (window.__inkwave).localRigs ? (window.__inkwave).localRigs.length : 0,
})`);
pws.close();
await sleep(300);
out.afterLeave = await evl(`JSON.stringify({ devs: [...((window.__inkwave).padDevices || new Map()).keys()] })`);
await shot('pad-pairing-final');

console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
