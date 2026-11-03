// 轻量搜索：MVP 阶段攻略数量不大，直接在内存里打分。
// 中文没有空格分词，所以对中文用“二字切片”（bigram）做模糊匹配。
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
    } else if (w.length >= 2) {
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
    content.steps.map((s) => `${s.action} ${s.expect ?? ''} ${s.notes ?? ''}`).join(' '),
    content.pitfalls.map((p) => `${p.symptom} ${p.cause ?? ''} ${p.fix}`).join(' '),
  ].join('\n');
}

// 标题和标签权重更高；返回 0 表示不相关
export function score(query, guide) {
  const q = tokenize(query);
  if (q.size === 0) return 1;
  const title = tokenize(guide.title);
  const tags = tokenize((guide.tags ?? []).join(' '));
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
  // 命中的查询词占比太低视为不相关，避免“注册”这种常见词把所有攻略都拉出来
  const coverage = hit / q.size;
  if (coverage < 0.34) return 0;
  return s * coverage;
}
