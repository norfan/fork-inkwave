// Simulated phone pad: joins the room shown on the big screen, claims a seat, then streams
// thumbstick + fire input so the host proves the phone-as-pad pipeline.
//   node tools/_pad-phone-sim.mjs <code> <name> [seconds]
const code = process.argv[2] || 'VC2G';
const name = process.argv[3] || 'Pixel';
const secs = Number(process.argv[4] || 30);
const port = 13000;
const ws = new WebSocket(`ws://127.0.0.1:${port}/room/${code}?name=${encodeURIComponent(name)}&v=1`);
const device = 'sim-' + Date.now().toString(36);
ws.onopen = () => {
  console.log('[sim] open, device=', device);
  ws.send('b|' + JSON.stringify({ t: 'padjoin', device, name }));
  let i = 0;
  const iv = setInterval(() => {
    if (ws.readyState !== 1) { clearInterval(iv); return; }
    i++;
    const a = i * 0.6;                       // right stick orbits
    const fire = (i % 40) < 6 ? 1 : 0;       // fire bursts
    ws.send('b|' + JSON.stringify({ t: 'padinput', device, d: {
      lx: +(Math.cos(i * 0.13)).toFixed(3), ly: +(Math.sin(i * 0.13)).toFixed(3),
      rx: +(Math.cos(a)).toFixed(3), ry: +(Math.sin(a)).toFixed(3),
      fire, jump: i % 120 < 4 ? 1 : 0, sub: 0, special: 0, squid: (i % 90) < 30 ? 1 : 0, map: 0,
    } }));
  }, 100);
  setTimeout(() => { clearInterval(iv); ws.close(); console.log('[sim] done'); process.exit(0); }, secs * 1000);
};
ws.onerror = (e) => { console.log('[sim] error', e.message || e); process.exit(1); };
ws.onmessage = (ev) => { const s = String(ev.data); if (s.includes('padseat')) console.log('[sim] seat:', s.slice(0, 120)); };
