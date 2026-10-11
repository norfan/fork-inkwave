// INKWAVE phone-as-pad LAN relay. One process serves BOTH the phone controller page
// (HTTP) and the WebSocket rooms the pad and the big screen join, so a phone only ever
// needs http://<pc-lan-ip>:13000 — the page's own origin becomes the WS target.
//
// Wire protocol mirrors the online relay (server/src/index.js): rooms keyed by code,
// raw payloads fan out as "m|<from>|<json>", control frames are JSON
// (welcome / join / leave / err / lock / pong), and a text "ping" is answered with "pong".
// The WS server is implemented by hand on top of Node's http (no external deps: the
// packaged app ships without node_modules, see the packager's --ignore).
//
// Used two ways:
//   - electron/main.cjs requires it and starts it inside the app (default port 13000)
//   - tools/serve-pad.mjs loads the same module for the plain-web (tools/serve.py) build
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROTO = 1;
const MAX = 8;                 // members per room (4 slots + a few spares)
const MSG_MAX = 65536;
const RATE = 120, RATE_BURST = RATE * 3, BURST_STRIKES = 4;
const CODE = /^[A-Z0-9]{4,8}$/;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

// LAN IPs shown to the user (pairing screen, QR host, room links). Virtual adapters
// (VMware / VirtualBox / Hyper-V vEthernet / Docker / WSL / VPN tunnels) and link-local
// APIPA addresses are useless for a phone on the same Wi-Fi, so only real Ethernet/Wi-Fi
// adapters are listed — falling back to the raw list when nothing real exists.
const VIRTUAL_IF = /VMware|VMnet|VirtualBox|vEthernet|Hyper-?V|Loopback|Docker|WSL|Tailscale|ZeroTier|Hamachi|tun|tap|br-|veth/i;
const APIPA_IP = /^169\.254\./;
function lanIPs() {
  const real = [], virt = [];
  const ifs = require('node:os').networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) {
        (APIPA_IP.test(a.address) || VIRTUAL_IF.test(name) ? virt : real).push({ name, ip: a.address });
      }
    }
  }
  return real.length ? real : virt;   // only virtual adapters when no real one exists
}

// ---- minimal RFC6455 server ----
function maskApply(buf, key, off = 0) {
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[(off + i) & 3];
  return buf;
}

class WsSocket {
  constructor(sock, relay, roomCode) {
    this.sock = sock;
    this.relay = relay;
    this.roomCode = roomCode;
    this.buf = Buffer.alloc(0);
    this.id = null;
    this.name = null;
    this.seq = 0;
    this.gone = false;
    this.at = Date.now();
    this.rate = { t: Date.now(), n: 0, strikes: 0 };
    sock.on('data', (d) => this._data(d));
    sock.on('error', () => this.close());
    sock.on('close', () => this.relay._gone(this));
  }

  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const f = this._frame();
      if (!f) break;
      if (f.opcode === 0x8) { this._sendFrame(0x8, f.payload); this.sock.end(); return; }
      if (f.opcode === 0x9) { this._sendFrame(0xa, f.payload); continue; }   // ping -> pong
      if (f.opcode === 0xa) continue;                                        // pong (ours: RTT bookkeeping not needed)
      if (f.opcode !== 0x1 || f.payload.length > MSG_MAX) continue;           // only text, size-capped
      this.relay._message(this, f.payload.toString('utf8'));
    }
  }

  // returns one complete frame (or null); leaves partials in this.buf
  _frame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const key = masked ? b.subarray(off, off + 4) : null;
    if (key) off += 4;
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (key) { payload = Buffer.from(payload); maskApply(payload, key); }
    // a text frame is never split here: control + tiny text frames only in practice; big frames would be
    // reassembled by the client into one send, and we cap at MSG_MAX anyway. Drop non-final frames defensively.
    if (!fin && opcode === 0x1) return null;
    this.buf = b.subarray(off + len);
    return { opcode, payload };
  }

  _sendFrame(opcode, payload) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const n = p.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | opcode, n]);
    else if (n <= 0xffff) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    try { this.sock.write(Buffer.concat([head, p])); } catch { /* closing */ }
  }

  text(s) { this._sendFrame(0x1, s); }
  close() { try { this.sock.end(); } catch { /* already closed */ } }
}

// ---- room bookkeeping (mirrors the Worker's semantics) ----
class PadRelay {
  constructor({ port = 13000, root } = {}) {
    this.port = port;
    this.root = root || path.join(__dirname, '..');
    this.rooms = new Map();   // code -> { members: WsSocket[] }
    this.server = http.createServer((req, res) => this._http(req, res));
    this.server.on('upgrade', (req, sock) => this._upgrade(req, sock));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        this.port = this.server.address().port;   // port 0 → OS picks one; report the real port
        resolve(this.port);
      });
    });
  }
  stop() { for (const r of this.rooms.values()) for (const m of r.members) m.close(); this.server.close(); }
  get ips() { return lanIPs(); }
  roomCount() { return this.rooms.size; }

  _file(urlPath) {
    // serve the game main page at / (browser play), /pad (controller page) + its static
    // assets and the pad APK from the project root; anything else resolves relative to the root.
    let p = urlPath === '/' ? 'index.html'
      : urlPath === '/pad' ? 'pad.html'
      : urlPath === '/inkwave-pad.apk' ? 'inkwave-pad.apk'
      : decodeURIComponent(urlPath).replace(/^\/+/, '');
    if (p.includes('..') || p.includes('\0')) return null;
    const file = path.join(this.root, p);
    return file.startsWith(this.root) && fs.existsSync(file) ? file : null;
  }

  _http(req, res) {
    const file = this._file(req.url.split('?')[0]);
    if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  _upgrade(req, sock) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    const fail = (msg) => { sock.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n' + msg); sock.destroy(); };
    if (!m || req.headers.upgrade?.toLowerCase() !== 'websocket') return fail('expected websocket');
    const code = m[1].toUpperCase();
    if (!CODE.test(code)) return fail('bad code');
    const key = req.headers['sec-websocket-key'];
    if (!key) return fail('no key');
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sock.resume();   // the http server pauses the socket on upgrade; without this no WS frame ever arrives
    this._join(code, url.searchParams, sock);
  }

  _join(code, qs, sock) {
    const room = this.rooms.get(code) || (this.rooms.set(code, { members: [] }), this.rooms.get(code));
    const ms = room.members;
    const create = qs.get('create') === '1';
    const fail = (c, e) => { const ws = new WsSocket(sock, this, code); ws.text(JSON.stringify({ t: 'err', c, e })); ws.close(); this._drop(code, ws); };
    if (+(qs.get('v') || 0) !== PROTO) return fail('ERR_STALE', 'Please refresh the page — the game was updated');
    if (create && ms.length) return fail('ERR_CODE_TAKEN', 'Room code taken');
    if (!create && !ms.length) return fail('ERR_NOT_FOUND', 'Room not found');
    if (ms.length >= MAX) return fail('ERR_FULL', 'Room is full');
    const ws = new WsSocket(sock, this, code);
    let id;
    do { id = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (ms.some((x) => x.id === id));
    ws.id = id;
    ws.name = (qs.get('name') || 'Player').replace(/[^\p{L}\p{N} ._\-!?']/gu, '').slice(0, 16) || 'Player';
    ws.seq = room.seq = (room.seq || 0) + 1;
    ms.push(ws);
    const all = ms.map((x) => ({ id: x.id, name: x.name }));
    ws.text(JSON.stringify({ t: 'welcome', id, host: all[0].id, members: all }));
    const j = JSON.stringify({ t: 'join', m: { id, name: ws.name } });
    for (const x of ms) if (x !== ws) x.text(j);
  }

  _message(ws, s) {
    if (!ws.id || ws.gone) return;
    const room = this.rooms.get(ws.roomCode);
    if (!room) return;
    const now = Date.now();
    ws.at = now;
    const r = ws.rate;
    if (now - r.t >= 1000) { r.strikes = r.n > RATE ? r.strikes + 1 : Math.max(0, r.strikes - 1); r.t = now; r.n = 0; }
    if (++r.n > RATE_BURST || r.strikes >= BURST_STRIKES) { ws.close(); this._gone(ws); return; }
    const c = s.charCodeAt(0);
    if (c === 98 && s.charCodeAt(1) === 124) {                        // "b|json"
      const out = 'm|' + ws.id + '|' + s.slice(2);
      for (const x of room.members) if (x !== ws) x.text(out);
      return;
    }
    if (c === 115 && s.charCodeAt(1) === 124) {                       // "s|to|json"
      const k = s.indexOf('|', 2);
      if (k < 0) return;
      const to = s.slice(2, k), out = 'm|' + ws.id + '|' + s.slice(k + 1);
      for (const x of room.members) if (x.id === to) { x.text(out); break; }
      return;
    }
    if (c === 123) {                                                   // JSON control frame
      let o; try { o = JSON.parse(s); } catch { return; }
      if (o.t === 'ping') ws.text(JSON.stringify({ t: 'pong', c: o.c }));
      else if (o.t === 'lock' && room.members[0] === ws) room.locked = !!o.v;
      return;
    }
    if (s === 'ping') { ws.text('pong'); return; }
  }

  _drop(code, ws) {
    const room = this.rooms.get(code);
    if (!room) return;
    const i = room.members.indexOf(ws);
    if (i >= 0) room.members.splice(i, 1);
    if (!room.members.length) this.rooms.delete(code);
  }

  _gone(ws) {
    if (!ws.id || ws.gone) return;
    ws.gone = true;
    const room = this.rooms.get(ws.roomCode);
    this._drop(ws.roomCode, ws);
    if (!room) return;
    const host = room.members.length ? room.members[0].id : null;
    const out = JSON.stringify({ t: 'leave', id: ws.id, host });
    for (const x of room.members) x.text(out);
  }
}

module.exports = { PadRelay, lanIPs };
