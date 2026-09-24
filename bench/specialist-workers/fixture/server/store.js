// Workspace settings, persisted to a JSON file.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = process.env.SETTINGS_FILE || fileURLToPath(new URL('../data/workspace.json', import.meta.url));
const KEYS = ['workspaceName', 'digest'];

// Read once at startup; settings rarely change.
const cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));

export function getSettings() {
  return cache;
}

export function putSettings(values) {
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const next = { ...onDisk };
  for (const k of KEYS) if (values[k] !== undefined) next[k] = values[k];
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}
