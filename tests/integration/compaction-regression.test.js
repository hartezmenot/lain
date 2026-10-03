'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, tmpdir } = require('../helpers');

const { App } = require('../../src/app');
const { Session } = require('../../src/session');
const mock = require('../../src/mockprovider');

function script(steps) {
  const dir = tmpdir('compact-reg-');
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, JSON.stringify(steps), 'utf8');
  process.env.LAIN_PROVIDER = 'mock';
  process.env.LAIN_MOCK_SCRIPT = file;
  process.env.LAIN_CONTEXT_BUDGET_TOKENS = '8000';
  mock._reset();
  return dir;
}

function unscript() {
  delete process.env.LAIN_PROVIDER;
  delete process.env.LAIN_MOCK_SCRIPT;
  delete process.env.LAIN_CONTEXT_BUDGET_TOKENS;
  mock._reset();
}

function app(cwd) {
  const a = new App({ interactive: false, cwd });
  a.render.write = () => {};
  a.render.notice = () => {};
  a.render.turnSummary = () => {};
  a.render.nl = () => {};
  a.session.save = () => {};
  return a;
}

function pressureSession() {
  const session = new Session({ cwd: process.cwd() });
  session.messages.push({ role: 'user', content: 'original objective' });
  for (let i = 0; i < 30; i++) {
    session.messages.push({
      role: 'assistant', content: `step ${i}`, ts: new Date().toISOString(),
      tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: JSON.stringify({ path: `f${i}.js` }) }],
    });
    session.messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(12000) });
  }
  return session;
}

module.exports = async function () {
};
