'use strict';

/**
 * THE CRAWL FALLBACK (D9) — when no router declares the screens, find them in the running app: Design's headless page
 * starts at the entry URL and follows same-origin links only, breadth first, within a depth and a count, deduped by
 * route pattern (`/users/42` and `/users/7` are one screen, `/users/:id`). Each found page is a screen with its URL.
 */

const pattern = (p) => p.split('/').map((s) => (/^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{36}$/i.test(s) ? ':id' : s)).join('/') || '/';

async function crawl(h, base, { start = '/', depth = 2, max = 20 } = {}) {
  const origin = new URL(base).origin;
  const seen = new Map(); const queue = [{ path: start, d: 0 }];
  while (queue.length && seen.size < max) {
    const { path, d } = queue.shift();
    const key = pattern(path);
    if (seen.has(key)) continue;
    // eslint-disable-next-line no-await-in-loop -- one page at a time, in order
    try { await h.goto(`${origin}${path}`); } catch { continue; }
    // eslint-disable-next-line no-await-in-loop
    const info = await h.page.eval(`({ title: document.title, links: [...document.querySelectorAll('a[href]')].map((a) => a.href) })`).catch(() => ({ title: '', links: [] }));
    seen.set(key, { id: key, name: key === '/' ? 'Home' : (key.split('/').filter(Boolean).pop() || key).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), file: null, route: path, pattern: key !== path ? key : null, home: key === '/', title: info.title, crawled: true });
    if (d >= depth) continue;
    for (const href of info.links) {
      let u; try { u = new URL(href); } catch { continue; }
      if (u.origin !== origin || /\.(png|jpe?g|svg|gif|pdf|zip|css|js)$/i.test(u.pathname)) continue;
      queue.push({ path: u.pathname, d: d + 1 });
    }
  }
  return [...seen.values()];
}

module.exports = { crawl, pattern };
