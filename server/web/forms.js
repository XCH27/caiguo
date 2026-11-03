// 网页表单处理（网页不执行脚本，所有交互都是普通表单提交）：
//   parseMultipart：解析带图片上传的表单
//   guideFromForm：把攻略编辑器的表单字段变成攻略数据（发布、存草稿、编辑共用）
//   guideToModel：把已有攻略变成编辑器要显示的数据

export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!m) return { fields: {}, files: {} };
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const fields = {};
  const files = {};
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // 结尾 --
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const head = buf.slice(start + 2, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd + 4);
    if (next < 0) break;
    const data = buf.slice(headEnd + 4, next - 2); // 去掉结尾的 \r\n
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
    if (name !== undefined) {
      if (filename !== undefined) {
        if (data.length) files[name] = { filename, mime: type, data };
      } else {
        fields[name] = data.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

const lines = (s) => String(s ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const val = (s) => {
  const t = String(s ?? '').trim();
  return t || undefined;
};
const count = (f, k, max) => Math.max(0, Math.min(max, Number(f[k]) || 0));

// “1@03:20; 2@第3段” → [{source:1, at:'03:20'}, {source:2, at:'第3段'}]
export function parseRefs(s) {
  return String(s ?? '').split(/[;；,，\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^\[?(\d+)\]?\s*(?:[@＠:：\s]\s*(.+))?$/.exec(x);
    if (!m) return null;
    return m[2] ? { source: Number(m[1]), at: m[2].trim() } : { source: Number(m[1]) };
  }).filter(Boolean);
}

export const refsText = (refs) => (refs ?? []).map((r) => (r.at ? `${r.source}@${r.at}` : String(r.source))).join('; ');

// “如果 用的是银联卡 → 换 Visa” 一行一个
export function parseBranches(s) {
  return lines(s).map((x) => {
    const m = /^(?:如果)?\s*(.+?)\s*(?:→|->|=>|：|:)\s*(.+)$/.exec(x);
    return m ? { when: m[1], then: m[2] } : null;
  }).filter(Boolean);
}

export const branchesText = (bs) => (bs ?? []).map((b) => `如果 ${b.when} → ${b.then}`).join('\n');

// “地区: 中国大陆” 一行一个
export function parsePairs(s) {
  const out = {};
  for (const x of lines(s)) {
    const m = /^(.+?)\s*[:：=]\s*(.+)$/.exec(x);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const pairsText = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');

// 合集条目：一行一条。“g_xxx 为什么收进来” 或 “https://… 标题 | 为什么收进来”
export function parseItems(text) {
  return lines(text).map((x) => {
    const [head, ...rest] = x.split(/\s+/);
    const tail = rest.join(' ');
    if (/^g_[\w-]+$/.test(head)) return tail ? { guide_id: head, note: tail } : { guide_id: head };
    if (/^https?:\/\//i.test(head)) {
      const [title, note] = tail.split('|').map((y) => y.trim());
      const o = { url: head };
      if (title) o.title = title;
      if (note) o.note = note;
      return o;
    }
    return null;
  }).filter(Boolean);
}

export const itemsText = (items) => (items ?? []).map((x) => (x.guide_id ? `${x.guide_id}${x.note ? ` ${x.note}` : ''}` : `${x.url}${x.title || x.note ? ` ${x.title ?? ''}${x.note ? ` | ${x.note}` : ''}` : ''}`)).join('\n');

// 表单 → 攻略数据。空行（没写动作的步骤、没写链接的出处、没写现象的坑点）会被忽略。
// 返回的 model 同时用于提交和出错时重新显示表单。
export function guideFromForm(f) {
  const steps = [];
  for (let i = 0; i < count(f, 'step_n', 80); i++) {
    const p = `s${i}_`;
    if (f[`${p}del`]) continue;
    const action = val(f[`${p}action`]);
    if (!action) continue;
    const target = {};
    for (const k of ['url', 'app', 'role', 'name', 'text']) if (val(f[`${p}${k}`])) target[k] = val(f[`${p}${k}`]);
    const st = {
      id: val(f[`${p}id`]),
      action,
      actor: f[`${p}actor`] === 'human' ? 'human' : 'agent',
      target: Object.keys(target).length ? target : undefined,
      expect: val(f[`${p}expect`]),
      notes: val(f[`${p}notes`]),
      screenshot: f[`${p}shot_del`] ? undefined : val(f[`${p}shot`]),
      irreversible: f[`${p}irr`] ? true : undefined,
      sensitive: f[`${p}sens`] ? true : undefined,
    };
    const refs = parseRefs(f[`${p}refs`]);
    if (refs.length) st.refs = refs;
    const br = parseBranches(f[`${p}branches`]);
    if (br.length) st.branches = br;
    for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
    st._row = i;
    steps.push(st);
  }
  const sources = [];
  for (let i = 0; i < count(f, 'src_n', 20); i++) {
    const p = `src${i}_`;
    if (f[`${p}del`] || !val(f[`${p}url`])) continue;
    const x = { type: f[`${p}type`] || 'other', url: val(f[`${p}url`]) };
    for (const k of ['platform', 'title', 'author', 'note']) if (val(f[`${p}${k}`])) x[k] = val(f[`${p}${k}`]);
    sources.push(x);
  }
  const pitfalls = [];
  for (let i = 0; i < count(f, 'pit_n', 50); i++) {
    const p = `p${i}_`;
    if (f[`${p}del`] || !val(f[`${p}symptom`])) continue;
    const x = { id: val(f[`${p}id`]), symptom: val(f[`${p}symptom`]), cause: val(f[`${p}cause`]), fix: val(f[`${p}fix`]) ?? '' };
    const n = Number(f[`${p}step`]);
    if (Number.isInteger(n) && n >= 1) x.step_pos = n;
    for (const k of Object.keys(x)) if (x[k] === undefined) delete x[k];
    pitfalls.push(x);
  }
  const tags = String(f.tags ?? '').split(/[\s,，、#]+/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
  const KIND_KEYS = ['guide', 'pitfall', 'review', 'list', 'news', 'ask', 'skill'];
  const model = {
    kind: KIND_KEYS.includes(f.kind) ? f.kind : 'guide',
    body: val(f.body),
    title: val(f.title) ?? '',
    summary: val(f.summary) ?? '',
    poster: val(f.poster),
    tags,
    origin: f.origin === 'external' ? 'external' : 'firsthand',
    sources,
    applies_to: parsePairs(f.applies),
    prerequisites: lines(f.prereq),
    steps,
    pitfalls,
  };
  if (model.kind === 'skill') model.skill = { name: val(f.skill_name), url: val(f.skill_url), install: val(f.skill_install) };
  if (model.kind === 'review' || val(f.subject_name)) model.subject = { type: f.subject_type || 'tool', name: val(f.subject_name), url: val(f.subject_url), version: val(f.subject_version) };
  if (model.kind === 'list' || val(f.items)) model.items = parseItems(f.items);
  for (const k of ['poster', 'body', 'subject', 'items']) if (model[k] === undefined) delete model[k];
  if (model.subject) for (const k of Object.keys(model.subject)) if (model.subject[k] === undefined) delete model.subject[k];
  return model;
}

// 去掉编辑器内部字段，变成发布用的数据（坑点的 step_pos 换成 step_id 序号）
export function publishInput(model) {
  const { steps, pitfalls, ...rest } = model;
  return {
    ...rest,
    steps: steps.map(({ id: _i, _row, ...s }) => s),
    pitfalls: pitfalls.map(({ id: _i, step_pos, ...p }) => (step_pos ? { ...p, step_id: String(step_pos) } : p)),
  };
}

// 编辑已公开攻略用：保留步骤和坑点的 id，网页编辑器据此生成修订
export function editInput(model) {
  const { steps, kind: _k, skill: _s, ...rest } = model;
  return { ...rest, steps: steps.map(({ _row, ...s }) => s) };
}

// 已有攻略 → 编辑器数据
export function guideToModel(content) {
  const pos = new Map(content.steps.map((s, i) => [s.id, i + 1]));
  return {
    kind: content.kind ?? 'guide',
    skill: content.skill,
    title: content.title,
    summary: content.summary,
    poster: content.poster,
    body: content.body,
    subject: content.subject,
    items: content.items,
    tags: content.tags ?? [],
    origin: content.origin ?? 'firsthand',
    sources: (content.sources ?? []).map(({ n: _n, ...x }) => x),
    applies_to: content.applies_to ?? {},
    prerequisites: content.prerequisites ?? [],
    steps: content.steps.map(({ rev: _r, ...s }) => s),
    pitfalls: content.pitfalls.map(({ step_id, ...p }) => ({ ...p, step_pos: step_id ? pos.get(step_id) : undefined })),
  };
}
