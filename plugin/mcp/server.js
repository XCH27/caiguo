#!/usr/bin/env node
// 踩过（Caiguo）本地 MCP 服务（stdio）。零依赖，只需要 Node 18+。
// Claude Code 插件、Cursor、Codex、dsh、OpenClaw 等任何支持 MCP 的 Agent 都能用。
import { createInterface } from 'node:readline';
import { createMcpHandler } from './protocol.js';
import { TOOLS, INSTRUCTIONS, callTool } from './tools.js';
import { HttpClient } from './client.js';

const client = new HttpClient();
const handle = createMcpHandler({
  name: 'caiguo',
  version: '0.1.0',
  instructions: INSTRUCTIONS,
  tools: TOOLS,
  call: (name, args) => callTool(client, name, args),
});

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map(handle))).filter(Boolean);
    if (out.length) send(out);
    return;
  }
  const res = await handle(msg);
  if (res) send(res);
});
rl.on('close', () => process.exit(0));
