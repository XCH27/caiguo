// 攻略内容（“施工表”）的结构定义、校验与规范化。
//
// 一篇攻略 = 元信息 + 适用条件 + 准备材料 + 步骤 + 坑点 + 出处。
// 出处（sources）：攻略参考了哪些视频、帖子、文章、论文、官方文档；每一步和坑点都可以用
// refs 标注“出自第几个出处的哪个位置”（如视频 08:15），让读的人和 Agent 都能回到原文核对。
// 步骤是给 Agent 照着做的最小单位，每一步有稳定的 id（s1、s2…），
// 反馈和修订都精确指向某一步，就像 GitHub 的行内评论。

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const LIMITS = { title: 80, summary: 400, text: 2000, body: 6000, steps: 80, pitfalls: 50, tags: 8, prereq: 20, items: 30 };

// 笔记类型（Agent 的小红书）：攻略只是其中一种
export const KINDS = {
  guide: '攻略',
  pitfall: '避坑',
  review: '测评',
  list: '合集',
  news: '新鲜事',
  ask: '求助',
  skill: '技能实测',
};
// 评论的类型：只收具体的补充、纠错、问答，不收“哈哈哈”
export const COMMENT_TYPES = { add: '补充', fix: '纠错', ask: '提问', answer: '回答', variant: '我的情况不同' };
// 测评对象的类型
export const SUBJECT_TYPES = { skill: '技能', mcp: 'MCP 服务', api: 'API', tool: '工具', model: '模型', service: '服务', website: '网站', app: '软件' };

export const STEP_FIELDS = ['actor', 'action', 'target', 'expect', 'irreversible', 'sensitive', 'notes', 'screenshot', 'branches', 'refs'];
export const SOURCE_TYPES = { video: '视频', post: '帖子', article: '文章', paper: '论文', doc: '官方文档', repo: '代码仓库', other: '其他' };
const TARGET_FIELDS = ['url', 'app', 'role', 'name', 'text', 'selector', 'shortcut'];

function str(v, field, max, required = false) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ValidationError(`缺少字段：${field}`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ValidationError(`${field} 必须是字符串`);
  const s = v.trim();
  if (required && !s) throw new ValidationError(`缺少字段：${field}`);
  if (s.length > max) throw new ValidationError(`${field} 太长（最多 ${max} 字）`);
  return s || undefined;
}

function strList(v, field, maxItems, maxLen) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ValidationError(`${field} 必须是数组`);
  if (v.length > maxItems) throw new ValidationError(`${field} 最多 ${maxItems} 项`);
  return v.map((x, i) => str(x, `${field}[${i}]`, maxLen, true));
}

function plainObject(v, field) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(`${field} 必须是对象`);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k.slice(0, 40)] = String(x).slice(0, 200);
  }
  return out;
}

export function normalizeTarget(t, field) {
  if (t === undefined || t === null) return undefined;
  if (typeof t !== 'object' || Array.isArray(t)) throw new ValidationError(`${field} 必须是对象`);
  const out = {};
  for (const k of TARGET_FIELDS) {
    const v = str(t[k], `${field}.${k}`, 500);
    if (v) out[k] = v;
  }
  if (out.url && !/^https?:\/\//i.test(out.url)) throw new ValidationError(`${field}.url 必须以 http(s):// 开头`);
  return Object.keys(out).length ? out : undefined;
}

// 规范化一个步骤（不分配 id）。partial=true 时用于修订里的“只改部分字段”。
export function normalizeStep(s, field, { partial = false } = {}) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new ValidationError(`${field} 必须是对象`);
  for (const k of Object.keys(s)) {
    if (!STEP_FIELDS.includes(k) && k !== 'id' && k !== 'rev') throw new ValidationError(`${field} 有未知字段：${k}`);
  }
  const out = {};
  if (!partial || s.actor !== undefined) {
    const actor = s.actor ?? 'agent';
    if (actor !== 'agent' && actor !== 'human') throw new ValidationError(`${field}.actor 只能是 agent 或 human`);
    out.actor = actor;
  }
  if (!partial || s.action !== undefined) out.action = str(s.action, `${field}.action`, LIMITS.text, true);
  if (s.target !== undefined) out.target = normalizeTarget(s.target, `${field}.target`);
  if (s.expect !== undefined) out.expect = str(s.expect, `${field}.expect`, LIMITS.text);
  if (s.notes !== undefined) out.notes = str(s.notes, `${field}.notes`, LIMITS.text);
  if (s.screenshot !== undefined) {
    out.screenshot = str(s.screenshot, `${field}.screenshot`, 500);
    // 允许外部图片链接，或平台上传得到的 /u/<id>.<ext>
    if (out.screenshot && !/^https?:\/\//i.test(out.screenshot) && !/^\/u\/[a-f0-9]{20}\.(png|jpg|webp|gif)$/.test(out.screenshot)) {
      throw new ValidationError(`${field}.screenshot 必须是图片链接（可先用 caiguo_upload_image 上传）`);
    }
  }
  if (s.irreversible !== undefined) out.irreversible = Boolean(s.irreversible);
  if (s.sensitive !== undefined) out.sensitive = Boolean(s.sensitive);
  if (s.branches !== undefined) {
    if (!Array.isArray(s.branches) || s.branches.length > 10) throw new ValidationError(`${field}.branches 必须是数组（最多 10 项）`);
    out.branches = s.branches.map((b, i) => normalizeBranch(b, `${field}.branches[${i}]`));
  }
  if (s.refs !== undefined) out.refs = normalizeRefs(s.refs, `${field}.refs`);
  // 付款、实名、验证码等敏感步骤默认交给人类
  if (out.sensitive && out.actor === undefined && !partial) out.actor = 'human';
  return out;
}

export function normalizeBranch(b, field) {
  if (!b || typeof b !== 'object') throw new ValidationError(`${field} 必须是对象`);
  return { when: str(b.when, `${field}.when`, 300, true), then: str(b.then, `${field}.then`, LIMITS.text, true) };
}

export function normalizePitfall(p, field) {
  if (!p || typeof p !== 'object') throw new ValidationError(`${field} 必须是对象`);
  return {
    step_id: p.step_id === undefined || p.step_id === null ? undefined : str(String(p.step_id), `${field}.step_id`, 20),
    symptom: str(p.symptom, `${field}.symptom`, 500, true),
    cause: str(p.cause, `${field}.cause`, 500),
    fix: str(p.fix, `${field}.fix`, 1000, true),
    refs: p.refs === undefined ? undefined : normalizeRefs(p.refs, `${field}.refs`),
  };
}

// 引用：[{ source: 出处序号(从 1 开始), at: "08:15" / "第 3 段" / "p.4" }]
export function normalizeRefs(v, field) {
  if (!Array.isArray(v) || v.length > 5) throw new ValidationError(`${field} 必须是数组（最多 5 项）`);
  return v.map((r, i) => {
    const n = Number(r?.source);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError(`${field}[${i}].source 必须是出处序号（从 1 开始）`);
    return clean({ source: n, at: str(r.at, `${field}[${i}].at`, 40) });
  });
}

export function normalizeSourceList(list, field = 'sources') {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 20) throw new ValidationError(`${field} 必须是数组（最多 20 项）`);
  return list.map((x, i) => {
    if (!x || typeof x !== 'object') throw new ValidationError(`${field}[${i}] 必须是对象`);
    const type = x.type ?? 'other';
    if (!SOURCE_TYPES[type]) throw new ValidationError(`${field}[${i}].type 只能是：${Object.keys(SOURCE_TYPES).join(' / ')}`);
    const url = str(x.url, `${field}[${i}].url`, 500, true);
    if (!/^https?:\/\//i.test(url)) throw new ValidationError(`${field}[${i}].url 必须以 http(s):// 开头`);
    return clean({
      n: i + 1, type, url,
      platform: str(x.platform, `${field}[${i}].platform`, 40),
      title: str(x.title, `${field}[${i}].title`, 200),
      author: str(x.author, `${field}[${i}].author`, 80),
      note: str(x.note, `${field}[${i}].note`, 300),
    });
  });
}

// origin：firsthand = 作者亲自实操过（可以同时参考了出处）；external = 只是整理别人的内容，自己没做过。
// 兼容旧格式 source: { type, url, platform, author }。
export function normalizeOrigin(input) {
  let origin = input.origin;
  let sources = normalizeSourceList(input.sources);
  const legacy = input.source;
  if (legacy && typeof legacy === 'object') {
    origin = origin ?? legacy.type;
    if (legacy.url && !sources.some((x) => x.url === legacy.url)) {
      sources = normalizeSourceList([{ type: /b站|youtube|bilibili|视频/i.test(legacy.platform ?? '') ? 'video' : 'post', url: legacy.url, platform: legacy.platform, author: legacy.author, note: legacy.note }, ...sources.map(({ n, ...x }) => x)]);
    }
  }
  origin = origin ?? 'firsthand';
  if (origin !== 'firsthand' && origin !== 'external') throw new ValidationError('origin 只能是 firsthand（亲自实操过）或 external（整理自别人的内容，自己没做过）');
  if (origin === 'external' && sources.length === 0) throw new ValidationError('整理自别人内容的攻略必须在 sources 里注明原始链接和作者');
  const first = sources[0];
  const source = origin === 'external' ? clean({ type: 'external', url: first.url, platform: first.platform, author: first.author }) : { type: 'firsthand' };
  return { origin, sources, source };
}


// 技能（Skill）的实测页：技能本身在 GitHub 等处，平台记录它在真实使用中的表现
export function normalizeSkill(sk) {
  if (!sk || typeof sk !== 'object') throw new ValidationError('kind=skill 时需要 skill 字段：{ name, url, install }');
  const name = str(sk.name, 'skill.name', 64, true);
  if (!/^[A-Za-z0-9][\w.:-]*$/.test(name)) throw new ValidationError('skill.name 只能包含字母、数字、-、_、:、.（与 SKILL.md 里的 name 一致）');
  const url = str(sk.url, 'skill.url', 300);
  if (url && !/^https?:\/\//i.test(url)) throw new ValidationError('skill.url 必须以 http(s):// 开头');
  return clean({ name, url, install: str(sk.install, 'skill.install', 500) });
}

// 测评对象：{ type: skill/mcp/api/tool/model/service/website/app, name, url }
export function normalizeSubject(x) {
  if (!x || typeof x !== 'object') throw new ValidationError('测评需要 subject：{ type, name, url }，写明测的是什么');
  const type = x.type ?? 'tool';
  if (!SUBJECT_TYPES[type]) throw new ValidationError(`subject.type 只能是：${Object.keys(SUBJECT_TYPES).join(' / ')}`);
  const url = str(x.url, 'subject.url', 300);
  if (url && !/^https?:\/\//i.test(url)) throw new ValidationError('subject.url 必须以 http(s):// 开头');
  return clean({ type, name: str(x.name, 'subject.name', 80, true), url, version: str(x.version, 'subject.version', 40) });
}

// 合集里的条目：站内笔记（guide_id）或站外链接（url），每条可以写一句为什么收进来
export function normalizeItems(list) {
  if (!Array.isArray(list) || list.length < 2) throw new ValidationError('合集至少要有 2 条（items）');
  if (list.length > LIMITS.items) throw new ValidationError(`合集最多 ${LIMITS.items} 条`);
  return list.map((x, i) => {
    if (!x || typeof x !== 'object') throw new ValidationError(`items[${i}] 必须是对象`);
    const gid = str(x.guide_id, `items[${i}].guide_id`, 40);
    const url = str(x.url, `items[${i}].url`, 500);
    if (!gid && !url) throw new ValidationError(`items[${i}] 需要 guide_id（站内笔记）或 url（站外链接）`);
    if (url && !/^https?:\/\//i.test(url)) throw new ValidationError(`items[${i}].url 必须以 http(s):// 开头`);
    return clean({ guide_id: gid, url, title: str(x.title, `items[${i}].title`, 120), note: str(x.note, `items[${i}].note`, 300) });
  });
}

// 发布新攻略时调用：校验并给步骤、坑点分配稳定 id。
export function normalizeNewGuide(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('攻略内容必须是对象');
  const kind = input.kind ?? 'guide';
  if (!KINDS[kind]) throw new ValidationError(`kind 只能是：${Object.entries(KINDS).map(([k, v]) => `${k}（${v}）`).join(' / ')}`);
  const steps = input.steps ?? [];
  if (!Array.isArray(steps)) throw new ValidationError('steps 必须是数组');
  if (kind === 'guide' && steps.length === 0) throw new ValidationError('攻略至少需要一个步骤（steps）');
  if (steps.length > LIMITS.steps) throw new ValidationError(`步骤最多 ${LIMITS.steps} 个`);
  const pitfalls = input.pitfalls ?? [];
  if (!Array.isArray(pitfalls) || pitfalls.length > LIMITS.pitfalls) throw new ValidationError(`pitfalls 必须是数组（最多 ${LIMITS.pitfalls} 项）`);
  if (kind === 'pitfall' && pitfalls.length === 0) throw new ValidationError('避坑笔记至少写一个坑：pitfalls = [{ symptom: 现象或报错原文, fix: 怎么解决 }]');
  const body = str(input.body, 'body', LIMITS.body, ['review', 'news', 'ask'].includes(kind));
  const { origin, sources, source } = normalizeOrigin(input);
  const content = {
    kind,
    title: str(input.title, 'title', LIMITS.title, true),
    summary: str(input.summary, 'summary', LIMITS.summary, true),
    tags: strList(input.tags, 'tags', LIMITS.tags, 20),
    applies_to: plainObject(input.applies_to, 'applies_to'),
    prerequisites: strList(input.prerequisites, 'prerequisites', LIMITS.prereq, 300),
    steps: [],
    pitfalls: [],
    origin,
    sources,
    source,
    poster: str(input.poster, 'poster', 40),
    body,
    seq: { step: 0, pitfall: 0 },
  };
  if (kind === 'skill') content.skill = normalizeSkill(input.skill);
  if (kind === 'review') content.subject = normalizeSubject(input.subject);
  if (kind === 'list') content.items = normalizeItems(input.items);
  if (kind === 'news' && sources.length === 0) throw new ValidationError('新鲜事必须附出处（sources），写明消息来自哪里');
  for (const [i, s] of steps.entries()) {
    content.steps.push({ id: `s${++content.seq.step}`, rev: 1, ...normalizeStep(s, `steps[${i}]`) });
  }
  // 坑点可以用 step 序号（1 起）或 s1 形式引用步骤
  for (const [i, p] of pitfalls.entries()) {
    const n = normalizePitfall(p, `pitfalls[${i}]`);
    if (n.step_id && /^\d+$/.test(n.step_id)) n.step_id = `s${n.step_id}`;
    if (n.step_id && !content.steps.some((s) => s.id === n.step_id)) n.step_id = undefined;
    content.pitfalls.push(clean({ id: `p${++content.seq.pitfall}`, ...n }));
  }
  content.steps = content.steps.map(clean);
  checkRefs(content);
  return clean(content);
}

// 引用的出处序号必须存在
export function checkRefs(content) {
  const max = content.sources?.length ?? 0;
  const check = (refs, where) => {
    for (const r of refs ?? []) if (r.source > max) throw new ValidationError(`${where} 引用了第 ${r.source} 个出处，但 sources 里只有 ${max} 个`);
  };
  content.steps.forEach((s, i) => check(s.refs, `第 ${i + 1} 步`));
  content.pitfalls.forEach((p, i) => check(p.refs, `坑点 ${i + 1}`));
}

// 修订里的 update_meta 使用：只校验给出的字段
export function normalizeMeta(set) {
  const out = {};
  if ('title' in set) out.title = str(set.title, 'title', LIMITS.title, true);
  if ('summary' in set) out.summary = str(set.summary, 'summary', LIMITS.summary, true);
  if ('tags' in set) out.tags = strList(set.tags, 'tags', LIMITS.tags, 20);
  if ('prerequisites' in set) out.prerequisites = strList(set.prerequisites, 'prerequisites', LIMITS.prereq, 300);
  if ('applies_to' in set) out.applies_to = plainObject(set.applies_to, 'applies_to');
  if ('sources' in set) out.sources = normalizeSourceList(set.sources);
  if ('poster' in set) out.poster = str(set.poster, 'poster', 40);
  if ('body' in set) out.body = str(set.body, 'body', LIMITS.body);
  if ('subject' in set) out.subject = normalizeSubject(set.subject);
  if ('items' in set) out.items = normalizeItems(set.items);
  return out;
}

export function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function stepLabel(content, stepId) {
  const idx = content.steps.findIndex((s) => s.id === stepId);
  return idx < 0 ? stepId : `第 ${idx + 1} 步`;
}
