'use strict';

/** LOOKING THINGS UP — the one place LAIN reads something it did not write. */

const redact = require('./redact');

/** A page is evidence, not a corpus. Bounded like every other input. */
const MAX_CHARS = 40_000;
const MAX_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 30_000;

/** WHAT LAIN SAYS IT IS. */
const UA = 'LAIN/2 (+https://github.com/lain-cli) coding-agent';

// ------------------------------------------------------------------ fetch --

/** http and https, and nothing else — no file:, no data:, no javascript:. */
function normalizeUrl(raw) {
  const text = redact.text(String(raw || '').trim());
  if (!text) return { ok: false, why: 'no url given' };
  let u;
  try { u = new URL(text); } catch { return { ok: false, why: `not a URL: ${text.slice(0, 120)}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      ok: false,
      why: `${u.protocol} is not fetchable. This reads http and https pages; for a file on this machine use read_file.`,
    };
  }
  return { ok: true, url: u.toString() };
}

/** HTML TO SOMETHING WORTH READING. */
/** THE PART OF THE PAGE THAT IS THE PAGE. */
const CONTENT = [
  /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  /<div[^>]*\bid=["']?(?:apicontent|content|main-content)\b[^>]*>([\s\S]*)<\/div>/i,
  /<div[^>]*\bclass=["'][^"']*\b(?:markdown-body|article-body)\b[^"']*["'][^>]*>([\s\S]*)<\/div>/i,
];

function mainRegion(html) {
  const s = String(html || '');
  for (const re of CONTENT) {
    const m = re.exec(s);
    // A mark that captures almost nothing is a mark on the wrong element — a
    // page whose <main> holds one heading is worse than the page.
    if (m && m[1] && m[1].length > 400) return m[1];
  }
  return s;
}

function htmlToText(html) {
  let s = mainRegion(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // The bodies, not just the tags: a stripped <script> leaves its source behind.
  s = s.replace(/<(script|style|noscript|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|table)\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCharCode(Number(d)); } catch { return ' '; } });
  // Whitespace last, so the newlines introduced above survive.
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return dropNavRuns(s.trim());
}

/** NAVIGATION IS NOT THE PAGE, AND IT IS MOST OF THE BYTES. */
const NAV_RUN = 25;
const NAV_LINE = 90;

function dropNavRuns(text) {
  const lines = String(text).split('\n');
  const out = [];
  let run = [];
  const isNav = (l) => {
    const t = l.trim();
    if (!t.startsWith('- ')) return false;
    const body = t.slice(2).trim();
    // A sentence has an end. A link label does not.
    return body.length > 0 && body.length <= NAV_LINE && !/[.!?:;]$/.test(body);
  };
  const flush = () => {
    if (run.length > NAV_RUN) out.push(`[${run.length} navigation links omitted]`);
    else out.push(...run);
    run = [];
  };
  for (const line of lines) {
    if (isNav(line)) { run.push(line); continue; }
    // A blank line inside a run is how the converter separates list items, so
    // it does not end the run — anything else does.
    if (!line.trim() && run.length) continue;
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? htmlToText(m[1]).slice(0, 200) : null;
}

/** GET a page and return what it says. */
async function fetchUrl(raw, { maxChars = MAX_CHARS, signal = null, fetchImpl = null } = {}) {
  const norm = normalizeUrl(raw);
  if (!norm.ok) return norm;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, why: 'this Node build has no fetch' };

  // The caller's cancellation AND a deadline of our own.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) return { ok: false, why: 'cancelled' };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await doFetch(norm.url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
    });
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    // A PDF, an image or a tarball is not something a model can read, and decoding megabytes of it into a context window is an expensive way to learn that.
    if (/^(image|audio|video)\//.test(type) || /application\/(pdf|zip|octet-stream)/.test(type)) {
      return {
        ok: false,
        why: `${norm.url} is ${type.split(';')[0]}, which is not readable as text. `
          + 'Download it with run_bash if you need the bytes.',
        status: res.status,
      };
    }
    const body = await res.text();
    if (body.length > MAX_BYTES) {
      return { ok: false, why: `${norm.url} returned ${body.length} bytes, past the ${MAX_BYTES} limit` };
    }
    const isHtml = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
    const text = isHtml ? htmlToText(body) : body.trim();
    const cut = text.length > maxChars;
    return {
      ok: true,
      url: res.url || norm.url,
      status: res.status,
      contentType: type.split(';')[0] || null,
      title: isHtml ? titleOf(body) : null,
      // REDACTED ON THE WAY IN AS WELL AS ON THE WAY OUT.
      text: redact.text(cut ? text.slice(0, maxChars) : text),
      truncated: cut,
    };
  } catch (e) {
    const why = ac.signal.aborted && !(signal && signal.aborted)
      ? `no answer within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`
      : (e && e.message) || String(e);
    return { ok: false, why: `${norm.url} — ${why}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------- telling --

/** ONE LINE IN THE CONVERSATION PER LOOKUP. */
function note(app, text) {
  try {
    if (app && app.ui && app.ui.enabled) app.ui.noteActor('web', String(text).slice(0, 200));
  } catch { /* the lookup still happened; the line is a courtesy */ }
}

module.exports = {
  fetchUrl, note, htmlToText, mainRegion, dropNavRuns, titleOf, normalizeUrl,
  MAX_CHARS, FETCH_TIMEOUT_MS, UA,
};
