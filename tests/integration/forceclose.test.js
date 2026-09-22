'use strict';

/**
 * FORCE-CLOSE MID-TURN — the real binary, killed hard (TerminateProcess on
 * Windows, SIGKILL elsewhere) while a command is running. Then the session is
 * loaded the way `lain --resume` loads it.
 *
 * Before inflight.js the session file held nothing of that turn: the person was
 * returned to the previous completed prompt. Now the user message, the completed
 * write and the in-flight command are on disk, and loading classifies the lost
 * command as UNKNOWN (not replayed) and keeps the turn as `crashed`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, tmpdir, runCli } = require('../helpers');

module.exports = async function () {
  await test('FORCE-CLOSE: hard-kill during a command keeps the turn; resume recovers it without replaying the command', async () => {
    const cwd = tmpdir('forceclose-');
    const configDir = path.join(cwd, '.config');
    const r = await runCli([], {
      cwd, configDir,
      stdin: 'write the note then run the long migration\n',
      script: [
        { text: 'Writing the note.', tool_calls: [{ name: 'write_file', input: { path: 'note.txt', content: 'kept' } }] },
        { text: 'Running the migration.', tool_calls: [{ name: 'run_bash', input: { command: 'sleep 25' } }] },
        { text: 'Done.' },
      ],
      timeoutMs: 9000,          // runCli kills the child HARD when this expires
    });
    assert.notStrictEqual(r.code, 0, 'the process was killed, not finished');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8'), 'kept', 'the write had landed before the kill');

    const dir = path.join(configDir, 'sessions');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.strictEqual(files.length, 1, `one session file: ${files}`);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.ok(raw.inflight, 'the dead turn is on disk as in-flight');
    assert.strictEqual(raw.inflight.tool && raw.inflight.tool.name, 'run_bash', 'caught during the command');
    assert.ok(raw.messages.some((m) => m.role === 'user' && /long migration/.test(m.content)), 'the request survived');

    const prev = process.env.LAIN_CONFIG_DIR;
    process.env.LAIN_CONFIG_DIR = configDir;
    try {
      const { Session } = require('../../src/session');
      const back = Session.resume(files[0].replace(/\.json$/, ''));
      assert.ok(back && back.recovered, 'loading it recovers the turn');
      assert.strictEqual(back.recovered.lost[0].state, 'UNKNOWN', 'the killed command is UNKNOWN, never re-run');
      const turn = back.turns[back.turns.length - 1];
      assert.strictEqual(turn.stopReason, 'crashed');
      assert.ok(turn.actions.some((a) => a.name === 'write_file' && a.ok), 'the completed write is in the recovered record');
      const calls = back.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
      const answered = new Set(back.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      assert.deepStrictEqual(calls.filter((id) => !answered.has(id)), [], 'every call has a result — the next request is valid');
    } finally {
      if (prev === undefined) delete process.env.LAIN_CONFIG_DIR; else process.env.LAIN_CONFIG_DIR = prev;
    }
  });
};
