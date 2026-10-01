'use strict';

/**
 * AN OS-BACKED SECRET STORE — so a new kind of credential does not become one
 * more plaintext field in config.json.
 *
 * ------------------------------------------------------------------------
 * WINDOWS: DPAPI, CurrentUser scope (System.Security.Cryptography.ProtectedData).
 * The blob on disk can be decrypted only by this Windows user on this machine;
 * copying the file elsewhere yields nothing. The secret travels to PowerShell
 * on STDIN, never on a command line (a command line is visible to every
 * process on the machine), and the output is base64 of the protected bytes.
 *
 * ELSEWHERE: `available()` is false and `put` refuses. A caller must then
 * decide not to keep the credential rather than fall back to plaintext —
 * falling back silently is the defect this file exists to prevent.
 *
 * WHAT USES IT: OAuth tokens (chatgptauth.js). API keys that already live in
 * config.json stay there (masked in every UI, redacted in every log); moving
 * the existing provider credential path is a separate, deliberate migration.
 *
 * Blobs live in <configDir>/secrets/<name>.dpapi — one file per secret, named
 * by a caller-chosen key, never by the secret.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

function dir() { return path.join(require('./config').configDir(), 'secrets'); }
function fileOf(name) {
  if (!NAME.test(String(name || ''))) throw new Error('a secret name is letters, digits, dot, dash and underscore');
  return path.join(dir(), `${name}.dpapi`);
}

function available() {
  return process.platform === 'win32' ? { ok: true, kind: 'dpapi' } : { ok: false, why: 'no OS secret store is wired on this platform; Noema will not keep this credential in plaintext' };
}

function ps(script, input) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(String(r.stderr || 'the secret store refused').trim().split('\n')[0]);
  return String(r.stdout || '').trim();
}

const PROTECT = "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); "
  + '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
const UNPROTECT = "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($s); "
  + '[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))';

/** Keep a secret (a string; callers JSON-encode objects). */
function put(name, secret) {
  const a = available();
  if (!a.ok) return { ok: false, why: a.why };
  const f = fileOf(name);
  const blob = ps(PROTECT, String(secret));
  if (!/^[A-Za-z0-9+/=]+$/.test(blob)) return { ok: false, why: 'the secret store returned something unexpected' };
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, blob);
  fs.renameSync(`${f}.tmp`, f);
  return { ok: true };
}

/** Read it back, or null when there is none. */
function get(name) {
  const a = available();
  if (!a.ok) return null;
  let blob;
  try { blob = fs.readFileSync(fileOf(name), 'utf8'); } catch { return null; }
  try { return ps(UNPROTECT, blob); } catch { return null; }
}

/**
 * MANY AT ONCE (Phase 8.1 performance): one PowerShell for every name instead of
 * one each — listing ten API routes cost ten spawns (~2.5 s) on every CLI start.
 * Returns { name: secret | null }. Nothing is printed; the pipe carries base64.
 */
const UNPROTECT_MANY = "Add-Type -AssemblyName System.Security; foreach ($l in ([Console]::In.ReadToEnd() -split \"`n\")) { $l=$l.Trim(); if (-not $l) { continue }; "
  + "try { $b=[Convert]::FromBase64String($l); $o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
  + "[Console]::Out.WriteLine([Convert]::ToBase64String($o)) } catch { [Console]::Out.WriteLine('-') } }";
function getMany(names) {
  const out = {};
  const want = [];
  for (const n of names || []) {
    out[n] = null;
    try { want.push({ n, blob: fs.readFileSync(fileOf(n), 'utf8').trim() }); } catch { /* none */ }
  }
  if (!want.length || !available().ok) return out;
  let text = '';
  try { text = ps(UNPROTECT_MANY, want.map((w) => w.blob).join('\n')); } catch { return out; }
  const lines = text.split(/\r?\n/);
  want.forEach((w, i) => { const l = (lines[i] || '').trim(); if (l && l !== '-') { try { out[w.n] = Buffer.from(l, 'base64').toString('utf8'); } catch { out[w.n] = null; } } });
  return out;
}

/**
 * THE SAME, WITHOUT BLOCKING (Phase 8.2): a CLI start used to wait ~250 ms on this
 * PowerShell before its first prompt. Resolves { name: secret | null }.
 */
function getManyAsync(names) {
  const out = {};
  const want = [];
  for (const n of names || []) {
    out[n] = null;
    try { want.push({ n, blob: fs.readFileSync(fileOf(n), 'utf8').trim() }); } catch { /* none */ }
  }
  if (!want.length || !available().ok) return Promise.resolve(out);
  return new Promise((resolve) => {
    let text = '';
    let child;
    try { child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', UNPROTECT_MANY], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { resolve(out); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { text += d; });
    child.on('error', () => resolve(out));
    child.on('close', (code) => {
      if (code === 0) {
        const lines = text.split(/\r?\n/);
        want.forEach((w, i) => { const l = (lines[i] || '').trim(); if (l && l !== '-') { try { out[w.n] = Buffer.from(l, 'base64').toString('utf8'); } catch { out[w.n] = null; } } });
      }
      resolve(out);
    });
    child.stdin.on('error', () => { /* reported by close */ });
    child.stdin.end(want.map((w) => w.blob).join('\n'));
  });
}

function has(name) { try { return fs.existsSync(fileOf(name)); } catch { return false; } }

function remove(name) {
  try { fs.unlinkSync(fileOf(name)); return true; } catch { return false; }
}

module.exports = { available, put, get, getMany, getManyAsync, has, remove, dir };
