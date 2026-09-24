// Sign-in against the single demo account.
import crypto from 'node:crypto';

const SALT = 'td-2024';

export function hashPassword(password, salt = SALT) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

// The demo password is "correct horse".
const USER = { username: 'ada', hash: hashPassword('correct horse') };

export function login({ username = '', password = '' }) {
  const known = String(username).toLowerCase() === USER.username;
  const a = Buffer.from(hashPassword(String(password)), 'hex');
  const b = Buffer.from(USER.hash, 'hex');
  if (known && crypto.timingSafeEqual(a, b)) {
    return { ok: true, token: crypto.randomBytes(16).toString('hex') };
  }
  return { ok: false, error: 'invalid credentials' };
}
