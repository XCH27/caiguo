// 轻量搜索：MVP 阶段攻略数量不大，直接在内存里打分。
// 中文没有空格分词，所以对中文用“二字切片”（bigram）做模糊匹配；
// 另对标题/标签整串命中、连续子串给额外加分（不引入向量库）。
// 上线后可换成 Postgres + pgvector 的混合检索（见 docs/PLAN.md）。

const CJK = /[㐀-鿿豈-﫿]/;

export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const w of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    if (CJK.test(w)) {
      const chars = [...w];
      if (chars.length === 1) tokens.add(w);
      for (let i = 0; i < chars.length - 1; i++) tokens.add(chars[i] + chars[i + 1]);
      // 三字及以上再加首尾单字，方便短查询（如「卡」）碰到长词
      if (chars.length >= 3) {
        tokens.add(chars[0]);
        tokens.add(chars[chars.length - 1]);
      }
    } else if (w.length >= 2) {
      tokens.add(w);
    } else if (w.length === 1 && /\d/.test(w)) {
      tokens.add(w);
    }
  }
  return tokens;
}

export function buildSearchText(content) {
  return [
    content.title,
    content.summary,
    (content.tags ?? []).join(' '),
    Object.entries(content.applies_to ?? {}).map(([k, v]) => `${k} ${v}`).join(' '),
    content.body ?? '',
    content.subject ? `${content.subject.name} ${content.subject.version ?? ''}` : '',
    content.skill?.name ?? '',
    (content.items ?? []).map((x) => `${x.title ?? ''} ${x.note ?? ''}`).join(' '),
    (content.steps ?? []).map((s) => `${s.action} ${s.expect ?? ''} ${s.notes ?? ''}`).join(' '),
    (content.pitfalls ?? []).map((p) => `${p.symptom} ${p.cause ?? ''} ${p.fix}`).join(' '),
  ].join('\n');
}

// 标题和标签权重更高；整串命中再加分。返回 0 表示不相关。
export function score(query, guide) {
  const raw = String(query ?? '').trim().toLowerCase();
  const q = tokenize(query);
  if (q.size === 0) return 1;
  const titleStr = String(guide.title ?? '').toLowerCase();
  const tagsArr = (guide.tags ?? []).map((t) => String(t).toLowerCase());
  const title = tokenize(guide.title);
  const tags = tokenize(tagsArr.join(' '));
  const body = tokenize(guide.search_text);
  let s = 0;
  let hit = 0;
  for (const tok of q) {
    let matched = false;
    if (title.has(tok)) { s += 3; matched = true; }
    if (tags.has(tok)) { s += 2; matched = true; }
    if (body.has(tok)) { s += 1; matched = true; }
    if (matched) hit++;
  }
  // 整查询串出现在标题 / 标签：强相关
  if (raw) {
    if (titleStr === raw) s += 12;
    else if (titleStr.includes(raw)) s += 8;
    if (tagsArr.some((t) => t === raw)) s += 6;
    else if (tagsArr.some((t) => t.includes(raw) || raw.includes(t))) s += 3;
  }
  // 命中的查询词占比太低视为不相关，避免“注册”这种常见词把所有攻略都拉出来
  // 单字查询（常见于中文短搜）要求必须命中，覆盖率阈值放宽到 1.0 已在 hit 判定里
  const coverage = hit / q.size;
  const minCov = (q.size <= 2 && [...raw].length <= 2) ? 0.5 : 0.34;
  if (coverage < minCov && s < 8) return 0;
  if (coverage < minCov && s >= 8) {
    // 整串标题/标签命中时即使 bigram 覆盖偏低也保留
    return s;
  }
  return s * coverage;
}
