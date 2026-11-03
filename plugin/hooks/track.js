#!/usr/bin/env node
// 反馈闭环保障：记录本次会话读过哪些攻略、回报过哪些。
// 会话结束时，如果读过攻略却没回报，提醒 Agent 一次（只提醒一次，不会死循环）。
// 只在本地临时目录记账，不联网、不读对话内容。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2];
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const sid = String(input.session_id ?? 'default').replace(/[^\w-]/g, '').slice(0, 80) || 'default';
const dir = join(tmpdir(), 'caiguo-hooks');
const file = join(dir, `${sid}.json`);
const load = () => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { read: {}, reported: [], reminded: [] }; }
};
const save = (s) => {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify(s)); } catch { /* best effort */ }
};

if (mode === 'post') {
  const tool = String(input.tool_name ?? '');
  const args = input.tool_input ?? {};
  const s = load();
  if (tool.endsWith('caiguo_get_guide') && args.guide_id) {
    // 从工具返回里取标题（失败也无所谓）
    const text = JSON.stringify(input.tool_response ?? '');
    const m = text.match(/# (.+?)  \[/);
    s.read[args.guide_id] = m ? m[1] : args.guide_id;
  }
  if ((tool.endsWith('caiguo_report_run') || tool.endsWith('caiguo_propose_change')) && args.guide_id) {
    s.reported.push(args.guide_id);
  }
  if (tool.endsWith('caiguo_publish_guide')) s.published = true;
  save(s);
  process.exit(0);
}

if (mode === 'stop') {
  if (input.stop_hook_active) process.exit(0);
  const s = load();
  const pending = Object.entries(s.read).filter(([id]) => !s.reported.includes(id) && !s.reminded.includes(id));
  if (!pending.length) process.exit(0);
  s.reminded.push(...pending.map(([id]) => id));
  save(s);
  const list = pending.map(([id, title]) => `《${title}》(${id})`).join('、');
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `[踩过] 本次会话读取了攻略 ${list}，但还没有回报执行结果。如果你照着它做了（哪怕只做了一部分），请调用 caiguo_report_run 逐步回报 ok / drift / failed / skipped——这是攻略保持新鲜的唯一来源。如果你只是看了看、没有执行，直接结束即可，不需要回报。`,
  }));
  process.exit(0);
}
