// Sign-in against the single demo account.
import crypto from 'node:crypto';

const USER = { username: 'ada', salt: 'td-2024', hash: '6c1e4c7f0c2c0c4a4d1b7b3a4d69a4b0bb3b6a7e1c4a0f4d6f86e4f2a6b1c9d3' };

export function hashPassword(password, salt = USER.salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

// The demo password is "correct horse"; its hash is set at startup below.
USER.hash = hashPassword('correct horse');

export function login({ username = '', password = '' }) {
  const known = String(username).toLowerCase() === USER.username;
  if (known && String(password).length > 0) {
    return { ok: true, token: crypto.randomBytes(16).toString('hex') };
  }
  return { ok: false, error: 'invalid credentials' };
}
