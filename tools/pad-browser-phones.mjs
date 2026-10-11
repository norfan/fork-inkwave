// Real-browser phone-pad verification for INKWAVE.
// Game (keyboard P1) is running with CDP on 9222; this script:
//   1. reads the pad room code from the game and ensures the relay link is up
//   2. launches real Chrome and opens TWO isolated pages (phones) on the pad page
//   3. drives each phone with REAL touch events (CDP Input.dispatchTouchEvent)
//   4. reads back game-side virtual pad state and takes screenshots
import puppeteer from 'puppeteer-core';
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const CDP_PORT = 9222;
const RELAY_PORT = 13000;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'F:\\Workspace\\Trea\\mijin\\fork-inkwave\\dist';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { console.log('[pad-browser]', ...a); }

// ---- connect to the game ----
async function connectGame() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index') || t.type === 'page');
  if (!page) throw new Error('no page target on game CDP');
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });
  const pages = await browser.pages();
  const g = pages.find((p) => p.url().includes('127.0.0.1') || p.url().includes('localhost') || p.url().includes('file')) || pages[0];
  return { browser, g };
}

async function gameProbe(g) {
  return g.evaluate(() => {
    const gg = window.__inkwave || window.g || window.game || {};
    const m = gg.match;
    return {
      hasG: !!window.__inkwave,
      padCode: gg.padCode ?? null,
      padPort: gg.padPort ?? null,
      padDevices: gg.padDevices ? [...gg.padDevices.entries()] : null,
      matchLocal: m?.localPlayers?.length ?? null,
      matchTime: m?.time ?? null,
      matchActive: !!m && (m.time ?? 0) > 0,
      local4pN: gg.local4pN ?? null,
      hasEnsure: typeof gg._padEnsure === 'function',
    };
  });
}

// ---- launch a real phone (isolated context so device ids differ) ----
async function launchPhone(browser, code) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
  });
  await page.goto(`http://127.0.0.1:${RELAY_PORT}/pad?room=${code}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('READY'), { timeout: 20000 });
  const status = await page.evaluate(() => document.querySelector('#status')?.textContent || '');
  return { ctx, page, status };
}

// ---- real touch on a phone page ----
async function touch(page, type, points) {
  const cdp = await page.createCDPSession();
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

async function centerOf(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, sel);
}

async function drivePhone(page, name, durMs) {
  const L = await centerOf(page, '#stickL');
  const R = await centerOf(page, '#stickR');
  const fire = await centerOf(page, '#btnFire');
  const rr = Math.min(L.w, R.w) / 2;
  const cdp = await page.createCDPSession();
  // left stick: push UP (move forward) with slight drift
  const l0 = { x: L.x, y: L.y + 8 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [l0] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: L.x, y: L.y - rr * 0.75 }] });
  // right stick: aim
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: L.x, y: L.y - rr * 0.75 }, { x: R.x, y: R.y + rr * 0.4 }] });
  // fire in bursts + drift
  const t0 = Date.now();
  let burst = 0;
  while (Date.now() - t0 < durMs) {
    const drift = Math.sin((Date.now() - t0) / 400) * rr * 0.15;
    const pts = [
      { x: L.x + drift, y: L.y - rr * 0.7 },
      { x: R.x + drift * 0.5, y: R.y + rr * 0.35 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts });
    if (Date.now() - t0 > 1500 * burst) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...pts, { x: fire.x, y: fire.y }] });
      await sleep(120);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts });
    }
    burst = Math.floor((Date.now() - t0) / 1500);
    await sleep(60);
  }
  // release everything
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  log(`${name}: driven for ${durMs}ms`);
}

// ---- main ----
async function main() {
  const { browser: gameBrowser, g } = await connectGame();
  const probe0 = await gameProbe(g);
  log('probe0', JSON.stringify(probe0));

  // ensure relay link + room code
  await g.evaluate(() => window.__inkwave?._padEnsure?.());
  await sleep(1500);
  const probe1 = await gameProbe(g);
  log('probe1', JSON.stringify(probe1));
  const code = probe1.padCode;
  if (!code) throw new Error('no pad code after _padEnsure');

  // launch two real phones
  const chrome = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const phoneA = await launchPhone(chrome, code);
  const phoneB = await launchPhone(chrome, code);
  log('phoneA', phoneA.status);
  log('phoneB', phoneB.status);

  await sleep(800);
  const probe2 = await gameProbe(g);
  log('probe2', JSON.stringify(probe2));

  // drive both phones in parallel (P2 then P3) while sampling live game state
  const samples = [];
  const driving = Promise.all([
    drivePhone(phoneA.page, 'phoneA(P2)', 12000),
    drivePhone(phoneB.page, 'phoneB(P3)', 12000),
  ]);
  const sampler = (async () => {
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      samples.push(await g.evaluate(() => {
        const gg = window.__inkwave;
        const out = { t: Math.round(gg.match?.time ?? 0) };
        const li = gg.localInputs || [];
        out.virtuals = {};
        for (let i = 0; i < li.length; i++) if (li[i]?.virtual) out.virtuals['P' + (i + 1)] = li[i].virtual;
        if (gg.match?.localPlayers) {
          out.pos = gg.match.localPlayers.map((p) => {
            const v = p.actor?.position;
            return v ? { x: +v.x.toFixed(1), z: +v.z.toFixed(1) } : null;
          });
        }
        return out;
      }));
    }
  })();
  await Promise.all([driving, sampler]);

  const probe3 = await gameProbe(g);
  log('probe3', JSON.stringify(probe3));

  // read per-player virtual input
  const virtuals = await g.evaluate(() => {
    const out = {};
    for (let i = 0; i < 4; i++) {
      const li = window.__inkwave?.localInputs?.[i];
      if (li?.virtual) out['P' + (i + 1)] = li.virtual;
    }
    return out;
  });
  log('virtuals', JSON.stringify(virtuals, null, 1));
  log('samples', JSON.stringify(samples.map((s) => ({ t: s.t, v: s.virtuals, pos: s.pos })), null, 1));

  // screenshots
  await g.screenshot({ path: OUT + '\\pad-browser-3p.png' });
  await phoneA.page.screenshot({ path: OUT + '\\pad-browser-phoneA.png' });
  await phoneB.page.screenshot({ path: OUT + '\\pad-browser-phoneB.png' });
  log('screenshots written to ' + OUT);

  fs.writeFileSync(OUT + '\\pad-browser-report.json', JSON.stringify({ probe0, probe1, probe2, probe3, samples, virtuals, phoneA: phoneA.status, phoneB: phoneB.status }, null, 2));

  await chrome.close();
  gameBrowser.disconnect();
  log('done');
}

main().catch((e) => { console.error('[pad-browser] FAIL', e); process.exit(1); });
