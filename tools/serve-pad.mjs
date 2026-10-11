// Standalone LAN phone-as-pad relay for the plain-web build (tools/serve.py). The desktop app embeds the same
// server (electron/main.cjs); run this when playing in Chrome so phones can reach http://<pc-ip>:13000.
//   node tools/serve-pad.mjs [port]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { PadRelay, lanIPs } = require('../electron/pad-relay.cjs');

const port = Number(process.argv[2] || 13000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relay = new PadRelay({ port, root });
try {
  const actual = await relay.start();
  const ips = lanIPs().map((x) => x.ip);
  console.log(`[pad-relay] listening on http://0.0.0.0:${actual}`);
  console.log(`[pad-relay] phones on the same Wi-Fi open one of:`);
  for (const ip of ips) console.log(`[pad-relay]   http://${ip}:${actual}/pad`);
  if (!ips.length) console.log('[pad-relay]   (no LAN IPv4 detected — check Wi-Fi / firewall)');
  console.log('[pad-relay] press Ctrl+C to stop');
} catch (e) {
  console.error('[pad-relay] failed to start:', e.message);
  process.exit(1);
}
