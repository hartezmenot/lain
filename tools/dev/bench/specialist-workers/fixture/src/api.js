// Client for the TeamDesk API. Every call goes through `request`.

/**
 * One JSON request, with retries.
 * `deps.fetchImpl` lets tests supply a fake fetch.
 */
export async function request(path, opts = {}, { retries = 2, fetchImpl = globalThis.fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(path, opts);
    if (res.ok) return res.json();
    if (attempt >= retries) throw new Error(`HTTP ${res.status} for ${path}`);
  }
}

/** The shape the UI uses for a user. */
export function normalizeUser(raw) {
  return { id: raw.id, displayName: raw.name, avatarUrl: raw.avatar };
}

export async function getMe(deps) {
  return normalizeUser(await request('/api/me', {}, deps));
}

export async function getSettings(deps) {
  return request('/api/settings', {}, deps);
}

let current = null;

/** Save settings; the last response becomes the current settings. */
export async function saveSettings(values, deps) {
  const saved = await request('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  }, deps);
  current = saved;
  return saved;
}

export function currentSettings() {
  return current;
}
