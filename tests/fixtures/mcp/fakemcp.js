#!/usr/bin/env node
'use strict';
// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), for tests only.
// Tools: echo (read-only), scene_add (not read-only). Resources: one. Prompts: none.
// FAKE_MCP_LOG, when set, records every method received.
const fs = require('fs');
const log = process.env.FAKE_MCP_LOG;
let buf = '';
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (log) fs.appendFileSync(log, `${m.method}\n`);
    if (m.id == null) continue;   // a notification
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'fake-godot', version: '1.0' }, capabilities: { tools: {}, resources: {} } } });
    else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
      { name: 'scene_add', description: 'Add a node to the open scene', inputSchema: { type: 'object', properties: { node: { type: 'string' } } } },
    ] } });
    else if (m.method === 'resources/list') out({ jsonrpc: '2.0', id: m.id, result: { resources: [{ uri: 'godot://project', name: 'Project settings' }] } });
    else if (m.method === 'tools/call') out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${m.params.name}: ${JSON.stringify(m.params.arguments)} env=${process.env.FAKE_TOKEN ? 'token-present' : 'no-token'}` }] } });
    else out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
  }
});
