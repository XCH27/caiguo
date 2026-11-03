// 端到端：用官方 MCP SDK 客户端分别连接
//   1) 插件里的本地 stdio 服务（plugin/mcp/server.js → HTTP API）
//   2) 平台的远程 HTTP 端点（/mcp）
// 走一遍“搜 → 读 → 回报 drift → 提修订 → 别人验证 → 作者收件箱 → 合并”。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
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
    'caiguo_console_link', 'caiguo_feed', 'caiguo_finish', 'caiguo_get_guide', 'caiguo_library', 'caiguo_manage', 'caiguo_next', 'caiguo_propose_change', 'caiguo_publish_guide',
    'caiguo_report_run', 'caiguo_review_change', 'caiguo_search', 'caiguo_start', 'caiguo_upload_image', 'caiguo_verify_change',
  ]);
  assert.match(A.client.getInstructions() ?? '', /实操攻略/);

  // A 发布攻略（第一次写操作时自动注册，凭据落盘）
  const pub = await A.client.callTool({
    name: 'caiguo_publish_guide',
    arguments: {
      title: '测试：开通某服务的 API',
      summary: '端到端测试用',
      tags: ['测试'],
      sources: [{ type: 'video', platform: 'B站', title: '开通教程', author: 'UP', url: 'https://example.com/v' }],
      steps: [
        { action: '打开控制台', target: { url: 'https://example.com/console' }, expect: '看到控制台' },
        { action: '点击“创建密钥”', target: { role: 'button', name: '创建密钥' }, expect: '弹出新密钥，联系 13812345678', refs: [{ source: 1, at: '03:20' }] },
        { actor: 'human', action: '把密钥保存到密码管理器', expect: '保存成功' },
      ],
    },
  });
  const out = text(pub);
  assert.match(out, /等待用户确认/);
  assert.match(out, /phone×1/); // 自动脱敏
  const gid = out.match(/guide_id: (g_\w+)/)[1];
  const cfg = JSON.parse(readFileSync(join(dirA, 'config.json'), 'utf8'));
  assert.ok(cfg.servers[base].api_key.startsWith('cg_'));

  // 用户打开确认链接，点“同意发布”（网页表单）
  const approveUrl = new URL(out.match(/确认链接（发给用户本人打开）：(\S+)/)[1]);
  assert.equal((await fetch(approveUrl)).status, 200);
  const form = new URLSearchParams({ k: approveUrl.searchParams.get('k'), action: 'approve' });
  const ok = await fetch(`${base}${approveUrl.pathname}`, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(ok.status, 303);

  // B 搜索并读取
  const s = text(await B.client.callTool({ name: 'caiguo_search', arguments: { query: '开通服务 API' } }));
  assert.match(s, new RegExp(gid));
  const g = text(await B.client.callTool({ name: 'caiguo_get_guide', arguments: { guide_id: gid } }));
  assert.match(g, /<<踩过攻略 开始>>/);
  assert.match(g, /找: 按钮「创建密钥」/);
  assert.match(g, /出处: \[1\] 03:20/);
  assert.match(g, /\[1\] 视频 · B站 · @UP ·《开通教程》/);
  assert.match(g, /\[手机号已隐藏\]/);
  // 同一份内容也能直接用网址读
  const md = await (await fetch(`${base}/g/${gid}.md`)).text();
  assert.match(md, /找: 按钮「创建密钥」/);

  // 导航式执行：开始 → 每步回报 → 本人步骤给出跟做链接 → 结束
  const st = text(await B.client.callTool({ name: 'caiguo_start', arguments: { guide_id: gid, env: { region: 'CN' } } }));
  const rid = st.match(/执行编号: (r_\w+)/)[1];
  assert.match(st, /## 第 1 步 \[s1\]/);
  await B.client.callTool({ name: 'caiguo_next', arguments: { run_id: rid, step_id: 's1', status: 'ok' } });
  const n2 = text(await B.client.callTool({ name: 'caiguo_next', arguments: { run_id: rid, step_id: 's2', status: 'ok' } }));
  assert.match(n2, /\[本人\]/);
  const follow = new URL(n2.match(/跟做页: (\S+)/)[1]);
  const fpage = await (await fetch(follow)).text();
  assert.match(fpage, /轮到你了/);
  await fetch(`${base}${follow.pathname}`, { method: 'POST', body: new URLSearchParams({ k: follow.searchParams.get('k'), step_id: 's3', action: 'done' }), redirect: 'manual' });
  const n3 = text(await B.client.callTool({ name: 'caiguo_next', arguments: { run_id: rid } }));
  assert.match(n3, /由用户在跟做页完成/);
  assert.match(n3, /所有步骤都已回报/);
  assert.match(text(await B.client.callTool({ name: 'caiguo_finish', arguments: { run_id: rid, outcome: 'success', rating: 'helpful' } })), /已结束/);

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

  // 作者的信息流 → 合并
  const box = text(await A.client.callTool({ name: 'caiguo_feed', arguments: { kind: 'mine' } }));
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
  assert.equal(tools.length, 15);
  const r = text(await client.callTool({ name: 'caiguo_feed', arguments: { kind: 'new' } }));
  assert.match(r, /信息流 new/);
  const link = text(await client.callTool({ name: 'caiguo_console_link', arguments: {} }));
  const loginUrl = link.match(/(http\S+\/login\/[a-f0-9]+)/)[1];
  const login = await fetch(loginUrl, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/me`, { headers: { cookie } })).text();
  assert.match(me, /等你处理/);
  assert.equal((await fetch(loginUrl, { redirect: 'manual' })).status, 403); // 只能用一次
  await client.close();
});

test('网页：主人登录后写攻略（带截图）→ 存草稿 → 发布 → 收藏 → 编辑出新版本；“我的”各页都能打开；Agent 能看到收藏', async () => {
  const reg = svc.registerAgent({ name: '网页测试Agent', owner_handle: 'webber' });
  const agent = svc.authenticate(reg.api_key);
  const { path } = svc.createLoginLink(agent);
  const login = await fetch(base + path, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });
  const csrf = (await (await get('/new')).text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const fd = (fields, file) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    if (file) f.append(file, new Blob([png], { type: 'image/png' }), 'shot.png');
    return f;
  };
  const fields = {
    csrf, step_n: '3', src_n: '1', pit_n: '1', title: '网页上写的测试攻略', summary: '测试用', tags: '测试 网页', origin: 'firsthand',
    s0_action: '打开设置页', s0_actor: 'agent', s0_url: 'https://example.com/settings', s0_expect: '看到设置页',
    s1_action: '扫码登录', s1_actor: 'human', s1_expect: '登录成功',
    src0_type: 'video', src0_url: 'https://www.bilibili.com/video/BV1xx', src0_platform: 'B站',
    s0_refs: '1@03:20', p0_step: '2', p0_symptom: '二维码过期', p0_fix: '刷新页面',
  };
  // “再加一步”只是重新显示表单，已上传的截图保留
  const more = await fetch(`${base}/new`, { method: 'POST', headers: { cookie }, body: fd({ ...fields, op: 'add_step' }, 's0_shot_file') });
  const moreHtml = await more.text();
  assert.equal(more.status, 200);
  assert.match(moreHtml, /name="s3_action"/);
  const shot = moreHtml.match(/name="s0_shot" value="(\/u\/[a-f0-9]+\.png)"/)[1];
  // 存草稿
  const draft = await fetch(`${base}/new`, { method: 'POST', headers: { cookie }, body: fd({ ...fields, s0_shot: shot, op: 'draft' }), redirect: 'manual' });
  assert.equal(draft.headers.get('location'), '/me/guides?status=draft');
  const gid = svc.myGuides(agent.owner_id)[0].id;
  assert.equal(svc.myGuides(agent.owner_id)[0].status, 'draft');
  assert.equal(svc.versionRow(gid, 1).content.steps[0].screenshot, shot);
  assert.deepEqual(svc.versionRow(gid, 1).content.steps[0].refs, [{ source: 1, at: '03:20' }]);
  // 改草稿并发布
  const pub = await fetch(`${base}/me/guides/${gid}/edit`, { method: 'POST', headers: { cookie }, body: fd({ ...fields, s0_shot: shot, title: '网页上写的测试攻略（改）', op: 'publish' }), redirect: 'manual' });
  assert.equal(pub.headers.get('location'), `/g/${gid}?published=1`);
  const page = await (await get(`/g/${gid}`)).text();
  assert.match(page, /（改）/);
  assert.match(page, /webber（本人）/);
  // 收藏到新收藏夹
  const save = await fetch(`${base}/g/${gid}/save`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, action: 'save', new_folder: '测试夹' }), redirect: 'manual' });
  assert.equal(save.status, 303);
  assert.match(await (await get('/me/saved')).text(), /测试夹/);
  assert.match((await (await fetch(`${base}/api/library?view=saved`, { headers: { authorization: `Bearer ${reg.api_key}` } })).json()).items[0].folder_name, /测试夹/);
  // 编辑已公开的攻略 → 新版本
  const edited = { ...fields, s0_id: 's1', s1_id: 's2', s0_shot: shot, s1_expect: '登录成功，跳到首页', p0_id: 'p1', op: 'save', rationale: '补充预期' };
  const ed = await fetch(`${base}/g/${gid}/edit`, { method: 'POST', headers: { cookie }, body: fd(edited), redirect: 'manual' });
  assert.equal(ed.headers.get('location'), `/g/${gid}?updated=1`);
  const g = svc.getGuide(gid);
  assert.equal(g.version, 2);
  assert.equal(g.content.steps[0].rev, 1);
  assert.equal(g.content.steps[1].rev, 2);
  // “我的”各页
  for (const p of ['/me', '/me/saved', '/me/history', '/me/history?who=agent', '/me/runs', '/me/guides', '/me/messages', '/me/settings', `/g/${gid}/edit`, '/about', '/login']) {
    assert.equal((await get(p)).status, 200, p);
  }
  assert.match(await (await get('/me/history')).text(), /网页上写的测试攻略/);
  // 下架后别人打不开，本人能看到
  await fetch(`${base}/me/guides/${gid}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, action: 'archive' }), redirect: 'manual' });
  assert.equal((await fetch(`${base}/g/${gid}`)).status, 404);
  assert.equal((await get(`/g/${gid}`)).status, 200);
  // 没有 csrf 的表单被拒绝
  assert.equal((await fetch(`${base}/me/guides/${gid}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=restore', redirect: 'manual' })).status, 403);
});

test('反馈闭环钩子：读过攻略没回报会提醒一次，回报过或已提醒过则放行', () => {
  const hook = join(root, 'plugin/hooks/track.js');
  const sid = `t${Date.now()}`;
  const tmp = mkdtempSync(join(tmpdir(), 'cg-hook-'));
  const env = { ...process.env, CAIGUO_CONFIG: join(tmp, 'config.json'), CAIGUO_USAGE_FILE: join(tmp, 'usage.json') };
  const call = (mode, input) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify({ session_id: sid, ...input }), encoding: 'utf8', env });
  call('post', { tool_name: 'mcp__plugin_caiguo_caiguo__caiguo_get_guide', tool_input: { guide_id: 'g_1' }, tool_response: { content: [{ type: 'text', text: '# 某攻略  [g_1] v1' }] } });
  const first = call('stop', {});
  assert.equal(JSON.parse(first.stdout).decision, 'block');
  assert.match(first.stdout, /某攻略/);
  assert.equal(call('stop', {}).stdout, ''); // 只提醒一次
  // 只读攻略、回答问题（没动手）→ 不提醒；读完后跑了命令 → 提醒
  const tr = (names) => {
    const f = join(tmp, `tr-${names.join('-')}.jsonl`);
    writeFileSync(f, names.map((name) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } })).join('\n'));
    return f;
  };
  for (const [names, expectBlock] of [[['mcp__x__caiguo_search', 'mcp__x__caiguo_get_guide'], false], [['mcp__x__caiguo_get_guide', 'Read', 'Bash'], true]]) {
    const sidT = `${sid}-${names.length}`;
    const callT = (mode, input) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify({ session_id: sidT, ...input }), encoding: 'utf8', env });
    callT('post', { tool_name: 'mcp__x__caiguo_get_guide', tool_input: { guide_id: 'g_t' } });
    assert.equal(callT('stop', { transcript_path: tr(names) }).stdout !== '', expectBlock);
  }
  // 新会话：回报过就不提醒
  const sid2 = `${sid}b`;
  const call2 = (mode, input) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify({ session_id: sid2, ...input }), encoding: 'utf8', env });
  call2('post', { tool_name: 'mcp__caiguo__caiguo_get_guide', tool_input: { guide_id: 'g_2' } });
  call2('post', { tool_name: 'mcp__caiguo__caiguo_report_run', tool_input: { guide_id: 'g_2' } });
  assert.equal(call2('stop', {}).stdout, '');
  // 按步执行：start 了没 finish → 提醒收尾；finish 之后不再提醒
  const sid4 = `${sid}d`;
  const call4 = (mode, input) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify({ session_id: sid4, ...input }), encoding: 'utf8', env });
  call4('post', { tool_name: 'mcp__caiguo__caiguo_start', tool_input: { guide_id: 'g_4' }, tool_response: { content: [{ type: 'text', text: '<<踩过攻略 开始>>\n# 跟做攻略\n攻略: g_4\n执行编号: r_abc123\n' }] } });
  const s4 = call4('stop', {});
  assert.match(s4.stdout, /r_abc123/);
  assert.match(s4.stdout, /caiguo_finish/);
  const sid5 = `${sid}e`;
  const call5 = (mode, input) => spawnSync(process.execPath, [hook, mode], { input: JSON.stringify({ session_id: sid5, ...input }), encoding: 'utf8', env });
  call5('post', { tool_name: 'mcp__caiguo__caiguo_start', tool_input: { guide_id: 'g_5' }, tool_response: { content: [{ type: 'text', text: '# 跟做攻略\n执行编号: r_def456\n' }] } });
  call5('post', { tool_name: 'mcp__caiguo__caiguo_finish', tool_input: { run_id: 'r_def456', outcome: 'success' } });
  assert.equal(call5('stop', {}).stdout, '');
  // stop_hook_active 时绝不阻塞
  const sid3 = `${sid}c`;
  spawnSync(process.execPath, [hook, 'post'], { input: JSON.stringify({ session_id: sid3, tool_name: 'x_caiguo_get_guide', tool_input: { guide_id: 'g_3' } }), env });
  assert.equal(spawnSync(process.execPath, [hook, 'stop'], { input: JSON.stringify({ session_id: sid3, stop_hook_active: true }), encoding: 'utf8', env }).stdout, '');
});

test('使用统计钩子：本地给技能调用计数，结束时上报，用得多又没反馈时偶尔提醒', async () => {
  const author = svc.authenticate(svc.registerAgent({ name: '技能作者', owner_handle: 'skill-author' }).api_key);
  svc.updateSettings(author.owner_id, { require_publish_approval: false });
  const { guide_id } = svc.publishGuide(author, {
    kind: 'skill', title: '表格技能实测页', summary: 's', skill: { name: 'sheet-helper' }, steps: [{ action: '安装' }],
  });
  const user = svc.registerAgent({ name: '用户Agent', owner_handle: 'skill-user' });
  const tmp = mkdtempSync(join(tmpdir(), 'cg-usage-'));
  const cfg = join(tmp, 'config.json');
  writeFileSync(cfg, JSON.stringify({ last_url: base, servers: { [base]: { api_key: user.api_key } } }));
  const env = { ...process.env, CAIGUO_CONFIG: cfg, CAIGUO_USAGE_FILE: join(tmp, 'usage.json'), CAIGUO_URL: '' };
  const hook = join(root, 'plugin/hooks/track.js');
  const run = (mode, input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [hook, mode], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify({ session_id: `u${Date.now()}`, ...input }));
  });
  for (let i = 0; i < 6; i++) await run('post', { tool_name: 'Skill', tool_input: { skill: 'sheet-helper' } });
  await run('post', { tool_name: 'Skill', tool_input: { skill: 'caiguo:using-guides' } }); // 自己的技能不计
  const out = await run('stop', {});
  assert.equal(svc.getGuide(guide_id).usage.uses_30d, 6);
  const usage = JSON.parse(readFileSync(join(tmp, 'usage.json'), 'utf8'));
  assert.deepEqual(usage.pending, {});
  assert.equal(usage.skills['sheet-helper'].guide_id, guide_id);
  assert.match(JSON.parse(out).reason, /sheet-helper（最近用了 6 次/);
  assert.equal(await run('stop', {}), ''); // 7 天内不重复提醒
});


test('给 Agent 的纯文本入口：/llms.txt、/search.md、/feed.md，网页里有指向纯文本的隐藏链接', async () => {
  const a = svc.authenticate(svc.registerAgent({ name: '文本测试', owner_handle: 'texttest' }).api_key);
  svc.updateSettings(a.owner_id, { require_publish_approval: false });
  const { guide_id } = svc.publishGuide(a, { title: '纯文本入口测试攻略', summary: 's', steps: [{ action: '做点什么', expect: '看到结果' }] });
  const llms = await (await fetch(`${base}/llms.txt`)).text();
  assert.match(llms, /search\.md\?q=/);
  assert.match(llms, /不替你判断/);
  const s = await fetch(`${base}/search.md?q=${encodeURIComponent('纯文本入口')}`);
  assert.match(s.headers.get('content-type'), /text\/markdown/);
  assert.match(await s.text(), new RegExp(guide_id));
  assert.match(await (await fetch(`${base}/feed.md?kind=new`)).text(), new RegExp(guide_id));
  const html = await (await fetch(`${base}/g/${guide_id}`)).text();
  assert.match(html, new RegExp(`<link rel="alternate" type="text/markdown" href="/g/${guide_id}.md"`));
  assert.match(html, new RegExp(`<meta name="caiguo:guide" content="${guide_id}">`));
  const neg = await fetch(`${base}/g/${guide_id}`, { headers: { accept: 'text/markdown' } });
  assert.match(await neg.text(), /<<踩过攻略 开始>>/);
});
