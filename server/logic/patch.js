// 修订提案（相当于 GitHub 的 PR）：一组针对攻略的操作。
// 这里负责：校验操作、应用到攻略上、按风险分级、生成人类可读的变更说明。

import {
  ValidationError, normalizeStep, normalizeBranch, normalizePitfall, normalizeMeta, clean, stepLabel,
} from './content.js';

export const OP_TYPES = ['replace_step', 'insert_step', 'remove_step', 'add_branch', 'add_pitfall', 'remove_pitfall', 'update_meta'];
const META_FIELDS = ['title', 'summary', 'tags', 'prerequisites', 'applies_to'];

export function normalizeOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new ValidationError('修订至少要包含一个操作（ops）');
  if (ops.length > 30) throw new ValidationError('一次修订最多 30 个操作');
  return ops.map((op, i) => {
    const f = `ops[${i}]`;
    if (!op || typeof op !== 'object' || !OP_TYPES.includes(op.op)) {
      throw new ValidationError(`${f}.op 必须是：${OP_TYPES.join(' / ')}`);
    }
    switch (op.op) {
      case 'replace_step': {
        need(op.step_id, `${f}.step_id`);
        const set = normalizeStep(op.set, `${f}.set`, { partial: true });
        if (!Object.keys(set).length) throw new ValidationError(`${f}.set 不能为空`);
        return { op: op.op, step_id: op.step_id, set };
      }
      case 'insert_step':
        return { op: op.op, after: op.after ?? null, step: clean(normalizeStep(op.step, `${f}.step`)) };
      case 'remove_step':
        need(op.step_id, `${f}.step_id`);
        return { op: op.op, step_id: op.step_id };
      case 'add_branch':
        need(op.step_id, `${f}.step_id`);
        return { op: op.op, step_id: op.step_id, branch: normalizeBranch(op.branch, `${f}.branch`) };
      case 'add_pitfall':
        return { op: op.op, pitfall: clean(normalizePitfall(op.pitfall, `${f}.pitfall`)) };
      case 'remove_pitfall':
        need(op.pitfall_id, `${f}.pitfall_id`);
        return { op: op.op, pitfall_id: op.pitfall_id };
      case 'update_meta': {
        if (!op.set || typeof op.set !== 'object') throw new ValidationError(`${f}.set 必须是对象`);
        for (const k of Object.keys(op.set)) {
          if (!META_FIELDS.includes(k)) throw new ValidationError(`${f}.set 不能修改 ${k}`);
        }
        const set = normalizeMeta(op.set);
        if (!Object.keys(set).length) throw new ValidationError(`${f}.set 不能为空`);
        return { op: op.op, set };
      }
      default:
        throw new ValidationError(`${f}.op 未知`);
    }
  });
}

function need(v, field) {
  if (typeof v !== 'string' || !v) throw new ValidationError(`缺少字段：${field}`);
}

// 把操作应用到攻略内容上，返回新内容（不修改原对象）。
// newVersion：应用后的新版本号，被修改过的步骤会记下 rev，
// 这样旧版本上针对“没被改过的步骤”的反馈仍然有效。
export function applyOps(content, ops, newVersion) {
  const c = structuredClone(content);
  const findStep = (id) => {
    const idx = c.steps.findIndex((s) => s.id === id);
    if (idx < 0) throw new ValidationError(`攻略里没有步骤 ${id}（可能已被其他修订删除，请基于最新版本重新提交）`);
    return idx;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'replace_step': {
        const idx = findStep(op.step_id);
        c.steps[idx] = clean({ ...c.steps[idx], ...op.set, rev: newVersion ?? c.steps[idx].rev });
        break;
      }
      case 'insert_step': {
        const step = { id: `s${++c.seq.step}`, rev: newVersion ?? 1, ...op.step };
        if (op.after === null || op.after === 'start') c.steps.unshift(step);
        else c.steps.splice(findStep(op.after) + 1, 0, step);
        break;
      }
      case 'remove_step': {
        const idx = findStep(op.step_id);
        c.steps.splice(idx, 1);
        if (c.steps.length === 0) throw new ValidationError('不能删除最后一个步骤');
        c.pitfalls = c.pitfalls.map((p) => (p.step_id === op.step_id ? clean({ ...p, step_id: undefined }) : p));
        break;
      }
      case 'add_branch': {
        const idx = findStep(op.step_id);
        const branches = c.steps[idx].branches ?? [];
        if (branches.length >= 10) throw new ValidationError('每个步骤最多 10 个分支');
        c.steps[idx] = { ...c.steps[idx], branches: [...branches, op.branch], rev: newVersion ?? c.steps[idx].rev };
        break;
      }
      case 'add_pitfall': {
        if (op.pitfall.step_id) findStep(op.pitfall.step_id);
        c.pitfalls.push({ id: `p${++c.seq.pitfall}`, ...op.pitfall });
        break;
      }
      case 'remove_pitfall': {
        const before = c.pitfalls.length;
        c.pitfalls = c.pitfalls.filter((p) => p.id !== op.pitfall_id);
        if (c.pitfalls.length === before) throw new ValidationError(`没有坑点 ${op.pitfall_id}`);
        break;
      }
      case 'update_meta': {
        // 复用新攻略的校验逻辑，保证字段合法
        for (const [k, v] of Object.entries(op.set)) c[k] = v;
        break;
      }
      default:
        break;
    }
  }
  return c;
}

const TEXT_FIELDS = new Set(['action', 'expect', 'notes', 'screenshot']);

// 风险分级：决定修订需要多少独立验证、能不能自动合并。
//   minor：改文字描述、补坑点 → 3 个独立验证 + 作者 7 天未处理即可自动合并
//   flow ：增删步骤、加分支、改适用条件 → 5 个独立验证 + 14 天
//   high ：碰到付款/不可逆/人类步骤、改了链接 → 必须作者或维护者确认
// 分级由服务器根据攻略原文计算，不信任提交者自报。
export function classifyRisk(content, ops) {
  const reasons = [];
  let level = 'minor';
  const bump = (l, why) => {
    const order = { minor: 0, flow: 1, high: 2 };
    if (order[l] > order[level]) level = l;
    reasons.push(why);
  };
  const stepOf = (id) => content.steps.find((s) => s.id === id);
  const isProtected = (s) => s && (s.sensitive || s.irreversible || s.actor === 'human');

  for (const op of ops) {
    if (op.op === 'replace_step') {
      const s = stepOf(op.step_id);
      const label = stepLabel(content, op.step_id);
      if (isProtected(s)) bump('high', `${label} 是付款/不可逆/人类步骤`);
      if (op.set.target?.url !== undefined && op.set.target.url !== s?.target?.url) bump('high', `${label} 修改了链接（防钓鱼，需人工确认）`);
      if ('actor' in op.set && op.set.actor !== s?.actor) bump('high', `${label} 改变了执行者（Agent/人类）`);
      if (('sensitive' in op.set && !op.set.sensitive && s?.sensitive) || ('irreversible' in op.set && !op.set.irreversible && s?.irreversible)) {
        bump('high', `${label} 去掉了安全标记`);
      }
      const onlyText = Object.keys(op.set).every((k) => TEXT_FIELDS.has(k) || k === 'target');
      if (!onlyText) bump('flow', `${label} 修改了步骤属性`);
      else reasons.push(`${label} 修改了描述`);
    } else if (op.op === 'insert_step') {
      if (op.step.sensitive || op.step.irreversible || op.step.target?.url) bump('high', '新增了涉及付款/不可逆/外部链接的步骤');
      else bump('flow', '新增了步骤');
    } else if (op.op === 'remove_step') {
      const s = stepOf(op.step_id);
      if (isProtected(s)) bump('high', `删除了${stepLabel(content, op.step_id)}（安全相关步骤）`);
      else bump('flow', `删除了${stepLabel(content, op.step_id)}`);
    } else if (op.op === 'add_branch') {
      bump('flow', `${stepLabel(content, op.step_id)} 增加了条件分支`);
    } else if (op.op === 'add_pitfall') {
      reasons.push('补充了坑点');
    } else if (op.op === 'remove_pitfall') {
      bump('flow', '删除了坑点');
    } else if (op.op === 'update_meta') {
      const keys = Object.keys(op.set);
      if (keys.some((k) => k === 'applies_to' || k === 'prerequisites')) bump('flow', '修改了适用条件或准备材料');
      else reasons.push('修改了标题/简介/标签');
    }
  }
  return { level, reasons: [...new Set(reasons)] };
}

// 生成人类可读的变更列表，网页和 Agent 都用它展示 diff。
export function describeOps(content, ops) {
  const lines = [];
  for (const op of ops) {
    const s = content.steps.find((x) => x.id === op.step_id);
    const label = op.step_id ? stepLabel(content, op.step_id) : '';
    switch (op.op) {
      case 'replace_step':
        for (const [k, v] of Object.entries(op.set)) {
          const before = s ? s[k] : undefined;
          lines.push({ kind: 'change', where: label, field: k, before: fmt(before), after: fmt(v) });
        }
        break;
      case 'insert_step':
        lines.push({ kind: 'add', where: op.after ? `${stepLabel(content, op.after)}之后` : '最前面', field: 'step', after: fmt(op.step.action) });
        break;
      case 'remove_step':
        lines.push({ kind: 'remove', where: label, field: 'step', before: fmt(s?.action) });
        break;
      case 'add_branch':
        lines.push({ kind: 'add', where: label, field: 'branch', after: `如果 ${op.branch.when} → ${op.branch.then}` });
        break;
      case 'add_pitfall':
        lines.push({ kind: 'add', where: op.pitfall.step_id ? stepLabel(content, op.pitfall.step_id) : '坑点', field: 'pitfall', after: `${op.pitfall.symptom} → ${op.pitfall.fix}` });
        break;
      case 'remove_pitfall':
        lines.push({ kind: 'remove', where: '坑点', field: 'pitfall', before: op.pitfall_id });
        break;
      case 'update_meta':
        for (const [k, v] of Object.entries(op.set)) lines.push({ kind: 'change', where: '攻略信息', field: k, before: fmt(content[k]), after: fmt(v) });
        break;
      default:
        break;
    }
  }
  return lines;
}

function fmt(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join('、');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}=${x}`).join('，');
  return String(v);
}
