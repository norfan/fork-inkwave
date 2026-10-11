// Big-screen side of the phone-as-pad link. The game (Electron or plain web) joins the
// same LAN room as the phones: we create the room, phones announce themselves with
// { t:'padjoin', device, name }, we answer with a targeted { t:'padseat', slot },
// and phones stream { t:'padinput', device, d:{...} } — wired straight into the matching
// Input via setVirtual (see src/core/input.js). Wire format matches the relay
// (electron/pad-relay.cjs / server/src/index.js): "b|json" broadcast, "m|from|json",
// JSON control frames welcome / join / leave / err.
import { ERR, netError } from './errors.js';

export const PAD_DEFAULT_PORT = 13000;

export class PadLink {
  constructor() {
    this.ws = null;
    this.id = null;
    this.code = '';
    this.onJoin = null;     // (m) => void   a member joined (phones and the host see each other)
    this.onLeave = null;    // (id) => void
    this.onMessage = null;  // (from, obj) => void   any relayed payload
    this.onClose = null;    // (reason) => void
    this.devices = new Map();   // device id → { slot, name }   (slot 2..4 = P2..P4)
  }

  /** Resolve with the welcome frame. `addr` = '127.0.0.1:13000' (default PAD_DEFAULT_PORT). */
  connect(code, name, { addr, create = true } = {}) {
    this.close();
    this.code = code;
    const host = addr || `127.0.0.1:${PAD_DEFAULT_PORT}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const url = `ws://${host}/room/${encodeURIComponent(code)}?name=${encodeURIComponent(name)}&v=1${create ? '&create=1' : ''}`;
      let ws;
      try { ws = new WebSocket(url); } catch { reject(netError(ERR.CONNECT, 'Could not connect')); return; }
      this.ws = ws;
      const timer = setTimeout(() => { done(reject, netError(ERR.CONNECT, 'Could not connect')); try { ws.close(); } catch { /* ignore */ } }, 8000);
      ws.onmessage = (ev) => {
        const s = typeof ev.data === 'string' ? ev.data : '';
        if (s === 'pong') return;
        if (s.charCodeAt(0) === 98 && s.charCodeAt(1) === 124) {        // "b|json" broadcast (leave, lock…)
          let o; try { o = JSON.parse(s.slice(2)); } catch { return; }
          this._ingest(null, o);
          return;
        }
        if (s.charCodeAt(0) === 109 && s.charCodeAt(1) === 124) {        // "m|from|json"
          const k = s.indexOf('|', 2);
          let obj; try { obj = JSON.parse(s.slice(k + 1)); } catch { return; }
          this._ingest(s.slice(2, k), obj);
          return;
        }
        let o; try { o = JSON.parse(s); } catch { return; }
        if (o.t === 'err') { done(reject, netError(o.c || ERR.CONNECT, o.e || 'Could not connect')); return; }
        if (o.t === 'welcome') { this.id = o.id; done(resolve, o); }
        this._ingest(null, o);
      };
      ws.onclose = (ev) => {
        if (!settled) { done(reject, netError(ERR.CONNECT, ev.reason || 'Disconnected')); return; }
        this.onClose?.(ev.reason || 'Disconnected');
      };
      ws.onerror = () => { if (!settled) done(reject, netError(ERR.CONNECT, 'Could not connect')); };
    });
  }

  _ingest(from, o) {
    if (o.t === 'join') this.onJoin?.(o.m);
    else if (o.t === 'leave') {
      const hit = [...this.devices.entries()].find(([, d]) => d.id === o.id);
      if (hit) this.devices.delete(hit[0]);
      this.onLeave?.(o.id);
      this.onMessage?.(null, o);   // let the host clean up its seats by connection id
    }
    else if (o.t === 'padjoin') { this.devices.set(o.device, { slot: 0, name: o.name || 'Phone', id: from }); this.onMessage?.(from, o); }
    else if (o.t === 'padinput') this.onMessage?.(from, o);
    else this.onMessage?.(from, o);
  }

  get open() { return !!this.ws && this.ws.readyState === 1; }

  broadcast(obj) { return this._raw('b|' + JSON.stringify(obj)); }
  sendTo(id, obj) { return this._raw('s|' + id + '|' + JSON.stringify(obj)); }
  lock(v) { return this._raw(JSON.stringify({ t: 'lock', v: !!v })); }

  _raw(s) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(s);
    return true;
  }

  close() {
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onclose = null; try { ws.close(1000, 'bye'); } catch { /* ignore */ } }
    this.devices.clear();
  }
}
