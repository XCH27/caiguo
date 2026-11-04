// 本地 / SQLite 友好的语义检索接口（不引入付费向量库）。
// 当前实现：对 bigram 做确定性哈希嵌入（伪向量），可与 logic/search.js 的关键词分做混合。
// 上线后可换成 Postgres + pgvector；本文件的 embedText / cosine / hybridScore 签名保持稳定。
// D7：混合分仍只表达「文字相关」，不掺质量加权。

import { tokenize, score as lexicalScore } from './search.js';

export const EMBED_DIM = 64;

/** 确定性伪随机：把 token 映射到 [0, dim) 的若干分量 */
function hashToken(tok, dim) {
  let h = 2166136261;
  for (let i = 0; i < tok.length; i++) {
    h ^= tok.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const i1 = (h >>> 0) % dim;
  const i2 = ((h >>> 8) ^ (h * 3)) % dim;
  const s1 = (h & 1) ? 1 : -1;
  const s2 = (h & 2) ? 1 : -1;
  return [
    [i1, s1],
    [i2 === i1 ? (i2 + 1) % dim : i2, s2 * 0.7],
  ];
}

/** @returns {Float32Array} 单位近似向量；空文本为零向量 */
export function embedText(text, dim = EMBED_DIM) {
  const v = new Float32Array(dim);
  const toks = tokenize(text);
  if (toks.size === 0) return v;
  for (const tok of toks) {
    for (const [i, w] of hashToken(tok, dim)) v[i] += w;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 关键词相关度为主，伪向量相似度为辅。lexical 为 0 时整体为 0（保持「不相关就不出」）。
 * @param {string} query
 * @param {{ title?: string, tags?: string[], search_text?: string }} guide
 * @param {{ lexicalWeight?: number }} [opts]
 */
export function hybridScore(query, guide, { lexicalWeight = 0.85 } = {}) {
  const lex = lexicalScore(query, guide);
  if (lex <= 0) return 0;
  const w = Math.min(1, Math.max(0, lexicalWeight));
  const qv = embedText(query);
  const dv = embedText([guide.title, (guide.tags ?? []).join(' '), guide.search_text ?? ''].join('\n'));
  const sem = Math.max(0, cosine(qv, dv)); // 负相关当 0
  // 把语义分映射到与关键词分相近的量级（关键词分通常 1～20）
  return lex * w + sem * (1 - w) * Math.max(lex, 4);
}

/** 预留：把向量写成可放进 SQLite BLOB 的 Buffer（上线迁 pgvector 前可落本地） */
export function vectorToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVector(buf, dim = EMBED_DIM) {
  const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  if (f.length !== dim) {
    const out = new Float32Array(dim);
    out.set(f.subarray(0, Math.min(f.length, dim)));
    return out;
  }
  return f;
}
