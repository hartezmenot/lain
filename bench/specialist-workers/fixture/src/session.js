// Signing in and out.
import { request } from './api.js';

export async function signIn(username, password, deps) {
  return request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }, { retries: 0, ...deps });
}

export function signOut() {
  document.cookie = 'td_token=; Max-Age=0; path=/';
}
