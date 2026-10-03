// Client for the TeamDesk API. Every call goes through `request`.

const RETRYABLE = new Set([502, 503, 504]);

/**
 * One JSON request, with retries for transient server errors only.
 * `deps.fetchImpl` lets tests supply a fake fetch.
 */
export async function request(path, opts = {}, { retries = 2, fetchImpl = globalThis.fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(path, opts);
    if (res.ok) return res.json();
    if (!RETRYABLE.has(res.status) || attempt >= retries) throw new Error(`HTTP ${res.status} for ${path}`);
  }
}

/** The API speaks snake_case (ADR-001); the UI uses camelCase. */
export function normalizeUser(raw) {
  return { id: raw.id, displayName: raw.display_name, avatarUrl: raw.avatar_url };
}

export async function getMe(deps) {
  return normalizeUser(await request('/api/me', {}, deps));
}

export async function getSettings(deps) {
  return request('/api/settings', {}, deps);
}

let current = null;
let seq = 0;

/** Save settings; only the most recently STARTED save may set the current settings. */
export async function saveSettings(values, deps) {
  const mine = ++seq;
  const saved = await request('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  }, deps);
  if (mine === seq) current = saved;
  return saved;
}

export function currentSettings() {
  return current;
}
