'use strict';

/** WHERE A PHONE CAN REACH THIS PC (§43–45) — one resolver. */

const os = require('os');
const crypto = require('crypto');

const ROUTE = Object.freeze({ LAN: 'LAN', TAILSCALE: 'Tailscale', ZEROTIER: 'ZeroTier', OFFLINE: 'offline' });
const VIRTUAL = /vethernet|wsl|docker|virtualbox|vmware|hyper-v|loopback|vbox|br-|virbr|tap|tun(?!nel)/i;

function isPrivate4(a) {
  const [x, y] = a.split('.').map(Number);
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}
function isCgnat(a) {
  const [x, y] = a.split('.').map(Number);
  return x === 100 && y >= 64 && y <= 127;
}

/** Classify this machine's interfaces into endpoints for `port`. */
function endpoints({ port = 0, interfaces = os.networkInterfaces(), host = os.hostname() } = {}) {
  const out = { lan: [], tailscale: [], zerotier: [] };
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs || []) {
      if (!a || a.internal || a.family !== 'IPv4' && a.family !== 4) continue;
      const url = `http://${a.address}:${port}`;
      if (/tailscale/i.test(name) || isCgnat(a.address)) out.tailscale.push(url);
      else if (/^zt|zerotier/i.test(name)) out.zerotier.push(url);
      else if (isPrivate4(a.address) && !VIRTUAL.test(name)) out.lan.push(url);
    }
  }
  const machine = crypto.createHash('sha256').update(`${host}|${os.platform()}`).digest('hex').slice(0, 16);
  const generation = crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 8);
  return { ...out, machine, host, generation, port };
}

function routeOf(eps, url) {
  if (eps.lan.includes(url)) return ROUTE.LAN;
  if (eps.tailscale.includes(url)) return ROUTE.TAILSCALE;
  if (eps.zerotier.includes(url)) return ROUTE.ZEROTIER;
  return null;
}

/** Probe all candidates in parallel and pick by preference. */
async function resolve(eps, { probe, lastWorking = null, timeoutMs = 900 } = {}) {
  const all = [...new Set([...(lastWorking ? [lastWorking] : []), ...eps.lan, ...eps.tailscale, ...eps.zerotier])];
  if (!all.length) return { route: ROUTE.OFFLINE, url: null, tried: [] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const results = await Promise.all(all.map(async (url) => {
    try { return { url, ok: Boolean(await probe(url, ctl.signal)) }; } catch { return { url, ok: false }; }
  }));
  clearTimeout(timer);
  const ok = new Set(results.filter((r) => r.ok).map((r) => r.url));
  const pick = eps.lan.find((u) => ok.has(u))
    || (lastWorking && ok.has(lastWorking) ? lastWorking : null)
    || eps.tailscale.find((u) => ok.has(u))
    || eps.zerotier.find((u) => ok.has(u))
    || null;
  return { route: pick ? routeOf(eps, pick) || ROUTE.LAN : ROUTE.OFFLINE, url: pick, tried: results };
}

function describe(r) {
  return r && r.url ? `CONNECTED · ${r.route}` : 'OFFLINE · Bot chat only';
}

module.exports = { ROUTE, endpoints, resolve, describe, routeOf, isPrivate4, isCgnat };
