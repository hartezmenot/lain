// Workspace settings, persisted to a JSON file.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = process.env.SETTINGS_FILE || fileURLToPath(new URL('../data/workspace.json', import.meta.url));
const KEYS = ['workspaceName', 'digest'];

let cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));

export function getSettings() {
  return cache;
}

export function putSettings(values) {
  const next = { ...cache };
  for (const k of KEYS) if (values[k] !== undefined) next[k] = values[k];
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}
