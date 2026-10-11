// Protocol self-test for the phone-as-pad LAN relay: boots the relay in-process, then drives a
// host + phone pair with Node's native WebSocket client and asserts every handshake/relay step.
//   node tools/pad-relay-test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { PadRelay } = require('../electron/pad-relay.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relay = new PadRelay({ port: 0, root });   // port 0 → OS picks a free port
const port = await relay.start();
const ws = (code, name, create) => new WebSocket(`ws://127.0.0.1:${port}/room/${code}?name=${encodeURIComponent(name)}&v=1${create ? '&create=1' : ''}`);
const wait = (w, pred, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting ' + pred)), ms);
  const h = (ev) => {
    const s = typeof ev.data === 'string' ? ev.data : '';
    if (s === 'pong') { if (pred('t', 'pong')) { cleanup(); res('pong'); } return; }
    if (s.charCodeAt(0) === 109 && s.charCodeAt(1) === 124) {
      const k = s.indexOf('|', 2);
      let o; try { o = JSON.parse(s.slice(k + 1)); } catch { return; }
      if (pred('m', o, s.slice(2, k))) { cleanup(); res(o); }
      return;
    }
    let o; try { o = JSON.parse(s); } catch { return; }
    if (pred('c', o)) { cleanup(); res(o); }
  };
  const cleanup = () => { clearTimeout(t); w.removeEventListener('message', h); };
  w.addEventListener('message', h);
});
const assert = (cond, name) => { if (!cond) throw new Error('FAIL: ' + name); console.log('  ok  ' + name); };

console.log('pad-relay protocol test');
const host = ws('TEST1', 'Host', true);
const hw = await wait(host, (_k, o) => o.t === 'welcome');
assert(hw.host === hw.id, 'host created room and is its own host');
assert(hw.members.length === 1, 'welcome lists one member');

const phone = ws('TEST1', 'Phone', false);
const pw = await wait(phone, (_k, o) => o.t === 'welcome');
assert(pw.members.length === 2, 'phone welcome lists host + phone');
await wait(host, (_k, o) => o.t === 'join' && o.m.name === 'Phone', 4000);

phone.send('b|{"t":"padjoin","device":"ph1","name":"Pixel"}');
const j = await wait(host, (_k, o) => o.t === 'padjoin' && o.device === 'ph1');
assert(j.name === 'Pixel', 'host receives padjoin broadcast');
const phoneId = pw.members.find((m) => m.name === 'Phone').id;
host.send(`s|${phoneId}|{"t":"padseat","slot":2}`);
const seat = await wait(phone, (_k, o) => o.t === 'padseat');
assert(seat.slot === 2, 'phone receives targeted padseat slot 2');

phone.send('b|{"t":"padinput","device":"ph1","d":{"lx":0.5,"ly":-0.2,"fire":1}}');
const inp = await wait(host, (_k, o) => o.t === 'padinput');
assert(inp.d.lx === 0.5 && inp.d.fire === 1, 'host receives streamed padinput');
assert(phone.readyState === 1 && host.readyState === 1, 'connections still open after stream');

// lock + pong + leave
host.send(JSON.stringify({ t: 'lock', v: true }));
host.send('ping');
const pong = await wait(host, (_k, o) => o === 'pong');
assert(pong === 'pong', 'text ping answered with pong');
phone.close();
await wait(host, (_k, o) => o.t === 'leave' && o.id === phoneId, 4000);
host.send('b|{"t":"padinput","device":"ph1","d":{}}');
await new Promise((r) => setTimeout(r, 150));
assert(relay.roomCount() === 1, 'room still exists with host only');
host.close();
await new Promise((r) => setTimeout(r, 200));
assert(relay.roomCount() === 0, 'empty room is cleaned up');

relay.stop();
console.log('ALL PASS');
