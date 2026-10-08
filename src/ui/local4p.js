// INKWAVE — local split-screen overlay (1–4 players on one machine, Mario Kart 8 style).
//
// The big single-player HUD (src/ui/hud.js) is hidden during split-screen; this module draws the essentials per
// quadrant: name tag, crosshair (+ on-target dot), ink bar, special meter, damage/hit flashes, low-ink warning,
// the splat card with respawn countdown, a "press any button" hint when a pad slot is empty — plus a shared
// top-centre banner/countdown (GO!, one minute, final count). The judge/results overlay belongs to the main HUD
// and survives its visibility toggle, so it keeps working as-is.
import { G } from '../core/ctx.js';
import { PLAYER } from '../config.js';

// same tiling as core/renderer.js splitRects, in percent-of-screen coordinates
function quadPct(n) {
  if (n === 2) return [{ l: 0, t: 0, w: 50, h: 100 }, { l: 50, t: 0, w: 50, h: 100 }];
  if (n === 3) return [{ l: 0, t: 0, w: 50, h: 100 }, { l: 50, t: 0, w: 50, h: 50 }, { l: 50, t: 50, w: 50, h: 50 }];
  return [
    { l: 0, t: 0, w: 50, h: 50 }, { l: 50, t: 0, w: 50, h: 50 },
    { l: 0, t: 50, w: 50, h: 50 }, { l: 50, t: 50, w: 50, h: 50 },
  ];
}

const CSS = `
.iw-4p{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:40;}
.iw-4p .iw4p-quad{position:absolute;overflow:hidden;}
.iw-4p .iw4p-name{position:absolute;top:10px;left:14px;font:800 15px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.5px;text-shadow:0 1px 3px rgba(0,0,0,.7);}
.iw-4p .iw4p-cross{position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%);opacity:.92;}
.iw-4p .iw4p-cross .tk{stroke:#fff;stroke-width:2;stroke-linecap:round;opacity:.9;}
.iw-4p .iw4p-cross.iw-hit .tk{stroke:#ffd54a;stroke-width:3;}
.iw-4p .iw4p-cross.iw-kill .tk{stroke:#ff6b5e;stroke-width:3.5;}
.iw-4p .iw4p-dot{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#fff;box-shadow:0 0 4px rgba(0,0,0,.8);transition:opacity .08s;}
.iw-4p .iw4p-bars{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);width:min(46%,240px);display:flex;flex-direction:column;gap:5px;}
.iw-4p .iw4p-bar{height:8px;border-radius:5px;background:rgba(0,0,0,.45);overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.4);}
.iw-4p .iw4p-bar>div{height:100%;border-radius:5px;width:0;transition:width .06s linear;}
.iw-4p .iw4p-ink{background:#fff;}
.iw-4p .iw4p-special{background:#ffd54a;}
.iw-4p .iw4p-flash{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 40%,rgba(255,40,60,.55) 100%);opacity:0;}
.iw-4p .iw4p-low{position:absolute;left:50%;top:62%;transform:translateX(-50%);font:900 22px/1 "Segoe UI",system-ui,sans-serif;color:#ffd54a;text-shadow:0 1px 4px rgba(0,0,0,.8);opacity:0;}
.iw-4p .iw4p-death{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;opacity:0;transition:opacity .18s;}
.iw-4p .iw4p-death.on{opacity:1;}
.iw-4p .iw4p-death-by{font:800 20px/1.3 "Segoe UI",system-ui,sans-serif;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.8);max-width:min(80%,360px);}
.iw-4p .iw4p-death-count{font:900 58px/1.1 "Segoe UI",system-ui,sans-serif;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.85);margin-top:8px;}
.iw-4p .iw4p-hint{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);font:700 13px/1.4 "Segoe UI",system-ui,sans-serif;color:rgba(255,255,255,.85);text-shadow:0 1px 3px rgba(0,0,0,.8);letter-spacing:1px;}
.iw-4p .iw4p-banner{position:absolute;top:14%;left:50%;transform:translateX(-50%);font:900 clamp(26px,5vw,54px)/1.2 "Segoe UI",system-ui,sans-serif;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.85);opacity:0;transition:opacity .25s;white-space:nowrap;}
.iw-4p .iw4p-count{position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);font:900 clamp(60px,16vw,180px)/1 "Segoe UI",system-ui,sans-serif;color:#fff;text-shadow:0 4px 18px rgba(0,0,0,.9);opacity:0;transition:opacity .3s;}
`;

const CROSS = `<svg class="iw4p-cross" viewBox="0 0 44 44">
  <line class="tk" x1="22" y1="6" x2="22" y2="15"/><line class="tk" x1="22" y1="29" x2="22" y2="38"/>
  <line class="tk" x1="6" y1="22" x2="15" y2="22"/><line class="tk" x1="29" y1="22" x2="38" y2="22"/>
</svg>`;

export class Local4P {
  constructor(root, n) {
    this.n = n;
    this.el = document.createElement('div');
    this.el.className = 'iw-4p';
    this.el.innerHTML = `<style>${CSS}</style>`;
    this.players = [];
    this.respawn = [];   // per-player { t, info } | null
    this.damageT = []; this.hitT = []; this.killT = []; this.lowT = [];
    const rects = quadPct(n);
    for (let i = 0; i < n; i++) {
      const rc = rects[i];
      const q = document.createElement('div');
      q.className = 'iw4p-quad';
      q.style.cssText = `left:${rc.l}%;top:${rc.t}%;width:${rc.w}%;height:${rc.h}%;`;
      q.innerHTML = `
        <div class="iw4p-name"></div>
        ${CROSS}<div class="iw4p-dot"></div>
        <div class="iw4p-bars"><div class="iw4p-bar iw4p-inkbar"><div class="iw4p-ink"></div></div><div class="iw4p-bar"><div class="iw4p-special"></div></div></div>
        <div class="iw4p-flash"></div>
        <div class="iw4p-low">LOW INK!</div>
        <div class="iw4p-death"><div class="iw4p-death-by"></div><div class="iw4p-death-count"></div></div>
        <div class="iw4p-hint">PRESS ANY BUTTON</div>`;
      const $ = (s) => q.querySelector(s);
      this.players.push({
        root: q, name: $('.iw4p-name'), cross: $('.iw4p-cross'), dot: $('.iw4p-dot'),
        ink: $('.iw4p-ink'), special: $('.iw4p-special'), flash: $('.iw4p-flash'), low: $('.iw4p-low'),
        death: $('.iw4p-death'), deathBy: $('.iw4p-death-by'), deathCount: $('.iw4p-death-count'), hint: $('.iw4p-hint'),
      });
      this.respawn[i] = null; this.damageT[i] = 0; this.hitT[i] = 0; this.killT[i] = 0; this.lowT[i] = 0;
      this.el.appendChild(q);
    }
    const shared = document.createElement('div');
    shared.innerHTML = `<div class="iw4p-banner"></div><div class="iw4p-count"></div>`;
    this.el.appendChild(shared);
    this.bannerEl = shared.querySelector('.iw4p-banner');
    this.countEl = shared.querySelector('.iw4p-count');
    this._bannerT = 0; this._countT = 0;
    root.appendChild(this.el);
  }

  _q(i) { return this.players[i]; }

  hit(i, kind) {
    const q = this._q(i); if (!q) return;
    q.cross.classList.add(kind === 'kill' ? 'iw-kill' : 'iw-hit');
    this.hitT[i] = 0.22; this.killT[i] = kind === 'kill' ? 0.5 : 0;
  }

  damage(i, amount, angle) {
    const q = this._q(i); if (!q) return;
    this.damageT[i] = Math.max(this.damageT[i], 0.25 + amount * 0.25);
  }

  lowInk(i) { this.lowT[i] = 1.4; }

  splatted(i, info) {
    const q = this._q(i); if (!q) return;
    q.deathBy.textContent = info.by ? `Splatted by ${info.by}` : 'Splatted!';
    q.deathBy.style.color = info.byColor || '#fff';
    q.deathCount.textContent = String(Math.max(0, Math.ceil(info.respawn ?? PLAYER.respawnTime)));
    q.death.classList.add('on');
    this.respawn[i] = { t: info.respawn ?? PLAYER.respawnTime, info };
  }

  respawned(i) {
    const q = this._q(i); if (!q) return;
    q.death.classList.remove('on');
    this.respawn[i] = null;
  }

  banner(kind, text) {
    this.bannerEl.textContent = text || '';
    this.bannerEl.style.opacity = 1;
    this._bannerT = 2.4;
  }

  countdown(n) {
    this.countEl.textContent = String(n);
    this.countEl.style.opacity = 1;
    this._countT = 1.0;
  }

  update(dt) {
    const slots = G.match?.localPlayers || [];
    for (let i = 0; i < this.n; i++) {
      const q = this._q(i); if (!q) continue;
      const lp = slots[i];
      if (!lp || !lp.actor) { q.root.style.display = 'none'; continue; }
      q.root.style.display = '';
      const a = lp.actor;
      q.name.textContent = a.name;
      q.name.style.color = G.teamHex?.[a.team] || '#fff';
      q.ink.style.width = `${Math.max(0, Math.min(1, a.ink / PLAYER.inkMax)) * 100}%`;
      const frac = a.specialFrac ? a.specialFrac() : 0;
      q.special.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      q.special.style.background = a.specialReady() ? '#ffd54a' : (G.teamHex?.[a.team] || '#fff');
      const on = !!(lp.controller && lp.controller.onTarget);
      q.dot.style.opacity = on ? 1 : 0.3;
      q.dot.style.background = on && a.enemyTeam !== undefined ? (G.teamHex?.[a.enemyTeam] || '#fff') : '#fff';
      // pad slot empty → hint (P1 never needs it; P2–P4 show until their pad connects)
      const inp = lp.input;
      const needPad = i > 0 && (!inp || !inp.pad);
      q.hint.style.display = needPad ? '' : 'none';
      // flashes decay
      if (this.damageT[i] > 0) { this.damageT[i] -= dt; q.flash.style.opacity = Math.max(0, Math.min(1, this.damageT[i] / 0.45)); }
      else q.flash.style.opacity = 0;
      if (this.hitT[i] > 0) { this.hitT[i] -= dt; if (this.hitT[i] <= 0) q.cross.classList.remove('iw-hit'); }
      if (this.killT[i] > 0) { this.killT[i] -= dt; if (this.killT[i] <= 0) q.cross.classList.remove('iw-kill'); }
      if (this.lowT[i] > 0) { this.lowT[i] -= dt; q.low.style.opacity = Math.max(0, Math.min(1, this.lowT[i] / 0.5)); }
      else q.low.style.opacity = 0;
      if (this.respawn[i]) {
        this.respawn[i].t -= dt;
        q.deathCount.textContent = String(Math.max(0, Math.ceil(this.respawn[i].t)));
        if (this.respawn[i].t <= 0) { this.respawn[i] = null; q.death.classList.remove('on'); }
      }
    }
    if (this._bannerT > 0) { this._bannerT -= dt; if (this._bannerT <= 0) this.bannerEl.style.opacity = 0; }
    if (this._countT > 0) { this._countT -= dt; if (this._countT <= 0) this.countEl.style.opacity = 0; }
  }

  dispose() { this.el?.remove(); }
}
