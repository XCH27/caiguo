#!/usr/bin/env node
// 两件事：
// 1. 反馈闭环保障：本次会话读过攻略却没回报 → 结束前提醒 Agent 一次。
// 2. 被动使用统计：人类一直在用某个 Skill 却从不评价，这里在本地默默计数
//    （只记技能名和次数，不记对话内容），会话结束时批量上报给平台；
//    某个在平台上有实测页的技能被用了很多次、却很久没有反馈时，偶尔提醒 Agent 给一条如实的反馈。
// 设置 CAIGUO_USAGE_SHARING=off 可关闭使用统计上报。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { HttpClient, configPath } from '../mcp/client.js';

const DAY = 864e5;
const NUDGE_AFTER_USES = 5;
const NUDGE_EVERY_DAYS = 7;

const mode = process.argv[2];
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); } catch { /* best effort */ } };

const sid = String(input.session_id ?? 'default').replace(/[^\w-]/g, '').slice(0, 80) || 'default';
const sessionFile = join(tmpdir(), 'caiguo-hooks', `${sid}.json`);
const usageFile = process.env.CAIGUO_USAGE_FILE || join(dirname(configPath()), 'usage.json');
const session = readJson(sessionFile, { read: {}, reported: [], reminded: [] });
const usage = readJson(usageFile, { pending: {}, skills: {} });

function skillNameOf(toolInput) {
  const raw = String(toolInput?.skill ?? toolInput?.command ?? toolInput?.name ?? '').trim().replace(/^\//, '');
  return raw.slice(0, 64);
}

if (mode === 'post') {
  const tool = String(input.tool_name ?? '');
  const args = input.tool_input ?? {};
  if (tool === 'Skill') {
    const name = skillNameOf(args);
    if (name && !name.startsWith('caiguo')) {
      usage.pending[name] = (usage.pending[name] ?? 0) + 1;
      const s = (usage.skills[name] ??= { uses_since_feedback: 0 });
      s.uses_since_feedback += 1;
      writeJson(usageFile, usage);
    }
    process.exit(0);
  }
  if (tool.endsWith('caiguo_get_guide') && args.guide_id) {
    const text = JSON.stringify(input.tool_response ?? '');
    const m = text.match(/# (.+?)  \[/);
    session.read[args.guide_id] = m ? m[1] : args.guide_id;
  }
  if ((tool.endsWith('caiguo_report_run') || tool.endsWith('caiguo_propose_change')) && args.guide_id) {
    session.reported.push(args.guide_id);
    // 给技能实测页回报过 → 重置该技能的“待反馈”计数
    for (const s of Object.values(usage.skills)) {
      if (s.guide_id === args.guide_id) { s.uses_since_feedback = 0; s.last_feedback_at = new Date().toISOString(); }
    }
    writeJson(usageFile, usage);
  }
  writeJson(sessionFile, session);
  process.exit(0);
}

// 读了攻略之后，Agent 有没有真的动手（执行命令、操作浏览器/电脑、访问网页、改文件）？
// 读不到会话记录时默认认为动过手（宁可多提醒一次）。
const PASSIVE = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'Read', 'Grep', 'Glob', 'Skill', 'AskUserQuestion', 'LS']);
function actedAfterReading(transcriptPath) {
  if (!transcriptPath) return true;
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n'); } catch { return true; }
  const tools = [];
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (e?.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const c of content) if (c?.type === 'tool_use') tools.push(String(c.name));
  }
  const lastRead = tools.findLastIndex((n) => n.endsWith('caiguo_get_guide'));
  if (lastRead < 0) return true;
  return tools.slice(lastRead + 1).some((n) => !n.includes('caiguo') && !PASSIVE.has(n));
}

async function flushUsage() {
  if (process.env.CAIGUO_USAGE_SHARING === 'off') return;
  const items = Object.entries(usage.pending).map(([skill_name, count]) => ({ skill_name, count }));
  if (!items.length) return;
  const client = new HttpClient();
  if (!client.apiKey) return; // 还没注册过就不上报
  try {
    const res = await fetch(`${client.url}/api/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${client.apiKey}` },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    const { matched } = await res.json();
    usage.pending = {};
    for (const [name, gid] of Object.entries(matched ?? {})) (usage.skills[name] ??= { uses_since_feedback: 0 }).guide_id = gid;
    writeJson(usageFile, usage);
  } catch {
    // 网络不通就下次再报
  }
}

if (mode === 'stop') {
  await flushUsage();
  if (input.stop_hook_active) process.exit(0);
  const reasons = [];

  const pending = Object.entries(session.read).filter(([id]) => !session.reported.includes(id) && !session.reminded.includes(id));
  // 只读了攻略、没有实际动手（只是回答问题）时不提醒，避免打扰
  if (pending.length && actedAfterReading(input.transcript_path)) {
    session.reminded.push(...pending.map(([id]) => id));
    const list = pending.map(([id, title]) => `《${title}》(${id})`).join('、');
    reasons.push(`本次会话读取了攻略 ${list}，但还没有回报执行结果。如果你照着它做了（哪怕只做了一部分），请调用 caiguo_report_run 逐步回报 ok / drift / failed / skipped，并给出 rating。如果只是看了看、没有执行，不需要回报。`);
  }

  const now = Date.now();
  const due = Object.entries(usage.skills).filter(([, s]) => s.guide_id && s.uses_since_feedback >= NUDGE_AFTER_USES
    && (!s.last_feedback_at || now - Date.parse(s.last_feedback_at) > NUDGE_EVERY_DAYS * DAY)
    && (!s.last_nudge_at || now - Date.parse(s.last_nudge_at) > NUDGE_EVERY_DAYS * DAY));
  if (due.length) {
    for (const [, s] of due) s.last_nudge_at = new Date().toISOString();
    writeJson(usageFile, usage);
    const list = due.map(([name, s]) => `${name}（最近用了 ${s.uses_since_feedback} 次，实测页 ${s.guide_id}）`).join('、');
    reasons.push(`用户最近频繁使用技能 ${list}，但还没有给过反馈。如果你对它的表现有确切的观察（帮了大忙 / 某一步总出错 / 和描述不符），可以用 caiguo_report_run(guide_id=实测页, outcome, rating, note) 如实回报一次；没有把握就不用回报，也不要编造。`);
  }

  writeJson(sessionFile, session);
  if (reasons.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: `[踩过] ${reasons.join('\n')}` }));
  process.exit(0);
}
