// 端到端：用官方 MCP SDK 客户端分别连接
//   1) 插件里的本地 stdio 服务（plugin/mcp/server.js → HTTP API）
//   2) 平台的远程 HTTP 端点（/mcp）
// 走一遍“搜 → 读 → 回报 drift → 提修订 → 别人验证 → 作者收件箱 → 合并”。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../server/db.js';
import { Caiguo } from '../server/service.js';
import { createApp } from '../server/app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let server;
let base;
let svc;

before(async () => {
  svc = new Caiguo(openDb(':memory:'));
  server = createServer(createApp(svc));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

function stdioClient(name, cfgDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'plugin/mcp/server.js')],
    env: { ...process.env, CAIGUO_URL: base, CAIGUO_CONFIG: join(cfgDir, 'config.json'), CAIGUO_AGENT_NAME: name, CAIGUO_OWNER: name },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  return { client, connect: () => client.connect(transport) };
}

const text = (r) => r.content.map((c) => c.text).join('\n');

test('本地 stdio 插件：标准 MCP 客户端可以完成完整闭环', async (t) => {
  const dirA = mkdtempSync(join(tmpdir(), 'cg-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'cg-b-'));
  const A = stdioClient('作者Agent', dirA);
  const B = stdioClient('路人Agent', dirB);
  await A.connect();
  await B.connect();
  t.after(async () => { await A.client.close(); await B.client.close(); });

  const { tools } = await A.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'caiguo_get_guide', 'caiguo_inbox', 'caiguo_propose_change', 'caiguo_publish_guide',
    'caiguo_report_run', 'caiguo_review_change', 'caiguo_search', 'caiguo_verify_change',
  ]);
  assert.match(A.client.getInstructions() ?? '', /实操攻略/);

  // A 发布攻略（第一次写操作时自动注册，凭据落盘）
  const pub = await A.client.callTool({
    name: 'caiguo_publish_guide',
    arguments: {
      title: '测试：开通某服务的 API',
      summary: '端到端测试用',
      tags: ['测试'],
      steps: [
        { action: '打开控制台', target: { url: 'https://example.com/console' }, expect: '看到控制台' },
        { action: '点击“创建密钥”', target: { role: 'button', name: '创建密钥' }, expect: '弹出新密钥，联系 13812345678' },
      ],
    },
  });
  const out = text(pub);
  assert.match(out, /已发布/);
  assert.match(out, /手机号×1/); // 自动脱敏
  const gid = out.match(/guide_id: (g_\w+)/)[1];
  const cfg = JSON.parse(readFileSync(join(dirA, 'config.json'), 'utf8'));
  assert.ok(cfg.servers[base].api_key.startsWith('cg_'));

  // B 搜索并读取
  const s = text(await B.client.callTool({ name: 'caiguo_search', arguments: { query: '开通服务 API' } }));
  assert.match(s, new RegExp(gid));
  const g = text(await B.client.callTool({ name: 'caiguo_get_guide', arguments: { guide_id: gid } }));
  assert.match(g, /<<社区攻略开始/);
  assert.match(g, /role=button  name="创建密钥"/);
  assert.match(g, /\[手机号已隐藏\]/);

  // B 执行后报告第 2 步 drift，并提交修订
  const rr = text(await B.client.callTool({
    name: 'caiguo_report_run',
    arguments: { guide_id: gid, version: 1, outcome: 'partial', env: { region: 'CN' }, step_results: [{ step_id: 's1', status: 'ok' }, { step_id: 's2', status: 'drift', observed: '按钮改名为“新建 API Key”' }] },
  }));
  assert.match(rr, /已记录/);
  const pr = text(await B.client.callTool({
    name: 'caiguo_propose_change',
    arguments: {
      guide_id: gid, base_version: 1, kind: 'fix', rationale: '按钮改名',
      ops: [{ op: 'replace_step', step_id: 's2', set: { action: '点击“新建 API Key”', target: { role: 'button', name: '新建 API Key' } } }],
      evidence: { outcome: 'success', env: { region: 'CN' } },
    },
  }));
  assert.match(pr, /修订已提交/);
  assert.match(pr, /小改动/);
  const pid = pr.match(/proposal_id: (p_\w+)/)[1];

  // 别人读攻略时能看到这一步的待合并修订
  const g2 = text(await A.client.callTool({ name: 'caiguo_get_guide', arguments: { guide_id: gid } }));
  assert.match(g2, /待合并修订/);

  // 作者收件箱 → 合并
  const box = text(await A.client.callTool({ name: 'caiguo_inbox', arguments: {} }));
  assert.match(box, /按钮改名为“新建 API Key”/);
  assert.match(box, new RegExp(pid));
  // 非作者不能合并
  const deny = await B.client.callTool({ name: 'caiguo_review_change', arguments: { proposal_id: pid, action: 'merge' } });
  assert.equal(deny.isError, true);
  const merged = text(await A.client.callTool({ name: 'caiguo_review_change', arguments: { proposal_id: pid, action: 'merge' } }));
  assert.match(merged, /v2/);
  const g3 = text(await B.client.callTool({ name: 'caiguo_get_guide', arguments: { guide_id: gid } }));
  assert.match(g3, /新建 API Key/);
  assert.match(g3, /v2/);

  // 工具参数错误时返回 isError，而不是让连接崩掉
  const bad = await B.client.callTool({ name: 'caiguo_report_run', arguments: { guide_id: gid, version: 2, outcome: 'success', step_results: [{ step_id: 's99', status: 'ok' }] } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /s99/);
});

test('远程 HTTP MCP 端点（/mcp）可被标准客户端连接', async () => {
  const reg = svc.registerAgent({ name: '远程Agent', owner_handle: 'remote' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${reg.api_key}` } },
  });
  const client = new Client({ name: 'remote-test', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  const r = text(await client.callTool({ name: 'caiguo_inbox', arguments: {} }));
  assert.match(r, /远程Agent/);
  await client.close();
});

test('反馈闭环钩子：读过攻略没回报会提醒一次，回报过或已提醒过则放行', () => {
  const hook = join(root, 'plugin/hooks/track.js');
  const sid = `t${Date.now()}`;
  const call = (mode, input) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify({ session_id: sid, ...input }), encoding: 'utf8' });
  call('post', { tool_name: 'mcp__plugin_caiguo_caiguo__caiguo_get_guide', tool_input: { guide_id: 'g_1' }, tool_response: { content: [{ type: 'text', text: '# 某攻略  [g_1] v1' }] } });
  const first = call('stop', {});
  assert.equal(JSON.parse(first.stdout).decision, 'block');
  assert.match(first.stdout, /某攻略/);
  assert.equal(call('stop', {}).stdout, ''); // 只提醒一次
  // 新会话：回报过就不提醒
  const sid2 = `${sid}b`;
  const call2 = (mode, input) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify({ session_id: sid2, ...input }), encoding: 'utf8' });
  call2('post', { tool_name: 'mcp__caiguo__caiguo_get_guide', tool_input: { guide_id: 'g_2' } });
  call2('post', { tool_name: 'mcp__caiguo__caiguo_report_run', tool_input: { guide_id: 'g_2' } });
  assert.equal(call2('stop', {}).stdout, '');
  // stop_hook_active 时绝不阻塞
  const sid3 = `${sid}c`;
  spawnSync(process.execPath, [hook, 'post'], { input: JSON.stringify({ session_id: sid3, tool_name: 'x_caiguo_get_guide', tool_input: { guide_id: 'g_3' } }) });
  assert.equal(spawnSync(process.execPath, [hook, 'stop'], { input: JSON.stringify({ session_id: sid3, stop_hook_active: true }), encoding: 'utf8' }).stdout, '');
});
