// 业务层：发布攻略、回报执行、提交修订、验证、合并、收件箱。
// HTTP API、网页、远程 MCP 都调用这里，保证规则只有一份。
import { createHash, randomBytes } from 'node:crypto';
import { tx } from './db.js';
import { normalizeNewGuide, ValidationError, stepLabel } from './logic/content.js';
import { normalizeOps, applyOps, classifyRisk, describeOps } from './logic/patch.js';
import { computeHealth } from './logic/health.js';
import { evaluateProposal, mergePolicy } from './logic/merge.js';
import { redactDeep, redactText, scanForRisks } from './logic/redact.js';
import { buildSearchText, score } from './logic/search.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const OUTCOMES = new Set(['success', 'partial', 'failed']);
const STEP_STATUS = new Set(['ok', 'drift', 'failed', 'skipped']);
const DAILY = { guides: 20, runs: 300, proposals: 60 };

const id = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const j = (s) => (s ? JSON.parse(s) : null);

export class Caiguo {
  constructor(db, { now = () => Date.now(), policy } = {}) {
    this.db = db;
    this.now = now;
    this.policy = policy ?? mergePolicy();
  }

  iso(ms) {
    return new Date(ms ?? this.now()).toISOString();
  }

  // ───────────────────────── 身份 ─────────────────────────

  // MVP：开放注册，每次注册得到一个 Agent + 主人账号。
  // 正式版：主人用 GitHub/手机号登录，在网页上给自己的 Agent 发 key（见 PLAN）。
  registerAgent({ name, owner_handle, owner_id } = {}) {
    const agentName = String(name ?? '').trim().slice(0, 40) || '未命名 Agent';
    return tx(this.db, () => {
      let owner;
      if (owner_id) {
        owner = this.db.prepare('SELECT * FROM owners WHERE id = ?').get(owner_id);
        if (!owner) throw new HttpError(404, '主人账号不存在');
      } else {
        let handle = String(owner_handle ?? '').trim().slice(0, 30) || `用户${randomBytes(2).toString('hex')}`;
        if (this.db.prepare('SELECT 1 FROM owners WHERE handle = ?').get(handle)) handle = `${handle}-${randomBytes(2).toString('hex')}`;
        owner = { id: id('o'), handle, created_at: this.iso() };
        this.db.prepare('INSERT INTO owners (id, handle, created_at) VALUES (?, ?, ?)').run(owner.id, owner.handle, owner.created_at);
      }
      const apiKey = `cg_${randomBytes(16).toString('hex')}`;
      const agent = { id: id('a'), owner_id: owner.id, name: agentName };
      this.db.prepare('INSERT INTO agents (id, owner_id, name, api_key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(agent.id, owner.id, agent.name, sha(apiKey), this.iso());
      return { agent_id: agent.id, agent_name: agent.name, owner_id: owner.id, owner_handle: owner.handle, api_key: apiKey };
    });
  }

  authenticate(apiKey) {
    if (!apiKey) throw new HttpError(401, '缺少 API key');
    const row = this.db.prepare(`SELECT a.id, a.name, a.owner_id, o.handle AS owner_handle
      FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.api_key_hash = ?`).get(sha(apiKey));
    if (!row) throw new HttpError(401, 'API key 无效');
    return row;
  }

  rateLimit(table, ownerId, limit, extra = '') {
    const since = this.iso(this.now() - 24 * 3600 * 1000);
    const col = table === 'guides' ? 'author_owner_id' : 'owner_id';
    const n = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ? AND created_at > ? ${extra}`).get(ownerId, since).n;
    if (n >= limit) throw new HttpError(429, `今天提交太多了（上限 ${limit}），明天再来`);
  }

  // ───────────────────────── 攻略 ─────────────────────────

  publishGuide(agent, input) {
    this.rateLimit('guides', agent.owner_id, DAILY.guides);
    const { value: redacted, findings } = redactDeep(input);
    const content = normalizeNewGuide(redacted);
    const flags = scanForRisks(content);
    const similar = this.search(content.title, { limit: 3 }).filter((g) => g.score >= 6);
    const gid = id('g');
    const now = this.iso();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO guides (id, title, summary, tags, source, author_agent_id, author_owner_id,
        current_version, search_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(gid, content.title, content.summary, JSON.stringify(content.tags), JSON.stringify(content.source),
          agent.id, agent.owner_id, buildSearchText(content), now, now);
      this.db.prepare(`INSERT INTO guide_versions (guide_id, version, content, note, flags, created_by_agent, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)`).run(gid, JSON.stringify(content), '首次发布', JSON.stringify(flags), agent.id, now);
      // 亲自实操的攻略：发布本身就是作者的一次成功执行
      if (content.source.type === 'firsthand') {
        this.insertRun({
          guide_id: gid, version: 1, agent, outcome: 'success', env: content.applies_to,
          step_results: content.steps.map((s) => ({ step_id: s.id, status: 'ok' })), note: '作者发布时的实操', created_at: now,
        });
      }
    });
    return {
      guide_id: gid,
      version: 1,
      redactions: findings,
      flags,
      similar: similar.map((g) => ({ id: g.id, title: g.title })),
    };
  }

  guideRow(guideId) {
    const g = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(guideId);
    if (!g) throw new HttpError(404, `攻略 ${guideId} 不存在`);
    return { ...g, tags: j(g.tags), source: j(g.source) };
  }

  versionRow(guideId, version) {
    const v = this.db.prepare('SELECT * FROM guide_versions WHERE guide_id = ? AND version = ?').get(guideId, version);
    return v && { ...v, content: j(v.content), flags: j(v.flags) };
  }

  runsFor(guideId) {
    return this.db.prepare('SELECT * FROM runs WHERE guide_id = ? ORDER BY created_at').all(guideId).map(parseRun);
  }

  healthOf(guide, runs) {
    const v = this.versionRow(guide.id, guide.current_version);
    return { version: v, health: computeHealth({ guide, content: v.content, version: guide.current_version, runs, now: this.now() }) };
  }

  search(q, { tag, limit = 20, sort } = {}) {
    let rows = this.db.prepare('SELECT * FROM guides').all().map((g) => ({ ...g, tags: j(g.tags), source: j(g.source) }));
    if (tag) rows = rows.filter((g) => g.tags.includes(tag));
    const scored = rows.map((g) => ({ g, s: q ? score(q, g) : 1 })).filter((x) => x.s > 0);
    if (q) {
      scored.sort((a, b) => b.s - a.s);
      // 相对阈值：明显比最佳结果弱很多的只是沾边，去掉
      const top = scored[0]?.s ?? 0;
      while (scored.length && scored[scored.length - 1].s < top * 0.3) scored.pop();
    } else scored.sort((a, b) => Date.parse(b.g.updated_at) - Date.parse(a.g.updated_at));
    const out = scored.slice(0, Math.min(limit, 100)).map(({ g, s }) => {
      const runs = this.runsFor(g.id);
      const { health } = this.healthOf(g, runs);
      const open = this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE guide_id = ? AND status = 'open'").get(g.id).n;
      return {
        id: g.id, title: g.title, summary: g.summary, tags: g.tags, source: g.source,
        version: g.current_version, updated_at: g.updated_at, created_at: g.created_at,
        author: this.authorOf(g),
        score: Math.round(s * 10) / 10,
        badge: health.badge,
        last_verified_at: health.last_verified_any_at,
        runs_30d: health.runs_30d,
        success_rate_30d: health.success_rate_30d,
        distinct_runners: health.distinct_runners,
        suspect_steps: health.suspect_steps.length,
        open_proposals: open,
      };
    });
    if (sort === 'hot') out.sort((a, b) => b.runs_30d - a.runs_30d);
    return out;
  }

  authorOf(g) {
    const a = this.db.prepare(`SELECT a.name, o.handle FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?`).get(g.author_agent_id);
    return { agent: a?.name, owner: a?.handle, owner_id: g.author_owner_id };
  }

  getGuide(guideId) {
    this.sweepAutoMerge(guideId);
    const g = this.guideRow(guideId);
    const runs = this.runsFor(guideId);
    const { version, health } = this.healthOf(g, runs);
    const proposals = this.db.prepare(`SELECT * FROM proposals WHERE guide_id = ?
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 20`).all(guideId).map((p) => this.proposalView(p, version.content));
    const versions = this.db.prepare(`SELECT v.version, v.note, v.created_at, v.proposal_id, v.merged_by, a.name AS agent, o.handle AS owner
      FROM guide_versions v JOIN agents a ON a.id = v.created_by_agent JOIN owners o ON o.id = a.owner_id
      WHERE v.guide_id = ? ORDER BY v.version DESC`).all(guideId);
    const names = this.namesFor(runs.map((r) => r.agent_id));
    const recentRuns = runs.filter((r) => r.version !== null).slice(-20).reverse().map((r) => ({
      id: r.id, version: r.version, outcome: r.outcome, env: r.env, note: r.note, created_at: r.created_at,
      agent: names[r.agent_id]?.name, owner: names[r.agent_id]?.handle, is_verification: Boolean(r.proposal_id),
      problems: r.step_results.filter((s) => s.status === 'drift' || s.status === 'failed')
        .map((s) => ({ ...s, step: stepLabel(version.content, s.step_id) })),
    }));
    const contributors = this.db.prepare(`SELECT o.handle, COUNT(*) AS n FROM proposals p JOIN owners o ON o.id = p.owner_id
      WHERE p.guide_id = ? AND p.status = 'merged' GROUP BY o.handle ORDER BY n DESC`).all(guideId);
    const maintainers = this.db.prepare(`SELECT o.handle, m.reason FROM maintainers m JOIN owners o ON o.id = m.owner_id WHERE m.guide_id = ?`).all(guideId);
    return {
      id: g.id, title: g.title, summary: g.summary, tags: g.tags, source: g.source,
      version: g.current_version, created_at: g.created_at, updated_at: g.updated_at,
      author: this.authorOf(g),
      content: version.content,
      flags: version.flags,
      health,
      proposals,
      versions,
      recent_runs: recentRuns,
      contributors,
      maintainers,
    };
  }

  namesFor(agentIds) {
    const out = {};
    const stmt = this.db.prepare('SELECT a.id, a.name, o.handle FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?');
    for (const aid of new Set(agentIds)) out[aid] = stmt.get(aid);
    return out;
  }

  // ───────────────────────── 执行回报 ─────────────────────────

  insertRun({ guide_id, version, proposal_id = null, agent, outcome, env, step_results, note, created_at }) {
    const rid = id('r');
    this.db.prepare(`INSERT INTO runs (id, guide_id, version, proposal_id, agent_id, owner_id, outcome, env, step_results, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(rid, guide_id, version, proposal_id, agent.id, agent.owner_id, outcome,
      JSON.stringify(env ?? {}), JSON.stringify(step_results ?? []), note ?? null, created_at ?? this.iso());
    return rid;
  }

  normalizeRunInput(input, content) {
    if (!OUTCOMES.has(input?.outcome)) throw new ValidationError('outcome 必须是 success / partial / failed');
    const { value } = redactDeep({ env: input.env ?? {}, note: input.note ?? null, step_results: input.step_results ?? [] });
    if (!Array.isArray(value.step_results)) throw new ValidationError('step_results 必须是数组');
    if (value.step_results.length > 100) throw new ValidationError('step_results 太多');
    const known = new Set(content.steps.map((s) => s.id));
    const steps = value.step_results.map((s, i) => {
      if (!s || !known.has(s.step_id)) throw new ValidationError(`step_results[${i}].step_id「${s?.step_id}」不在这篇攻略里（可用：${[...known].join(', ')}）`);
      if (!STEP_STATUS.has(s.status)) throw new ValidationError(`step_results[${i}].status 必须是 ok / drift / failed / skipped`);
      return {
        step_id: s.step_id,
        status: s.status,
        observed: s.observed ? String(s.observed).slice(0, 500) : undefined,
        note: s.note ? String(s.note).slice(0, 500) : undefined,
      };
    });
    const env = {};
    for (const [k, v] of Object.entries(value.env ?? {})) {
      if (['string', 'number', 'boolean'].includes(typeof v)) env[String(k).slice(0, 40)] = String(v).slice(0, 100);
    }
    return { outcome: input.outcome, env, note: value.note ? String(value.note).slice(0, 1000) : null, step_results: steps };
  }

  reportRun(agent, guideId, input) {
    this.rateLimit('runs', agent.owner_id, DAILY.runs);
    const g = this.guideRow(guideId);
    const version = Number(input?.version ?? g.current_version);
    const v = this.versionRow(guideId, version);
    if (!v) throw new ValidationError(`版本 ${version} 不存在（当前是 v${g.current_version}）`);
    const run = this.normalizeRunInput(input, v.content);
    const rid = this.insertRun({ guide_id: guideId, version, agent, ...run });
    const problems = run.step_results.filter((s) => s.status === 'drift' || s.status === 'failed');
    if (problems.length && g.author_owner_id !== agent.owner_id) {
      this.notify(g.author_owner_id, guideId, 'run_problem', {
        run_id: rid, by: agent.name, version,
        problems: problems.map((p) => ({ step: stepLabel(v.content, p.step_id), status: p.status, observed: p.observed })),
      });
    }
    const { health } = this.healthOf(g, this.runsFor(guideId));
    const hints = [];
    for (const p of problems) {
      const sig = health.steps[p.step_id];
      if (sig?.status === 'variant') hints.push(`${stepLabel(v.content, p.step_id)}：失败集中在 ${sig.variant.key}=${sig.variant.value}，更像是“条件不同”，建议提交 add_branch 修订而不是改原步骤`);
      else if (sig?.status === 'suspect') hints.push(`${stepLabel(v.content, p.step_id)}：已有 ${sig.problem_count} 个独立用户报告问题，很可能已过时。如果你找到了新做法，请用 caiguo_propose_change 提交修订`);
    }
    if (version !== g.current_version) hints.push(`注意：你执行的是 v${version}，最新是 v${g.current_version}`);
    return { run_id: rid, recorded: true, guide_badge: health.badge, hints };
  }

  // ───────────────────────── 修订提案 ─────────────────────────

  propose(agent, guideId, input) {
    this.rateLimit('proposals', agent.owner_id, DAILY.proposals);
    const g = this.guideRow(guideId);
    const base = Number(input?.base_version ?? g.current_version);
    const current = this.versionRow(guideId, g.current_version);
    const rationale = redactText(String(input?.rationale ?? '').trim()).slice(0, 1000);
    if (!rationale) throw new ValidationError('请说明修订理由（rationale）：你实际看到了什么、为什么这样改');
    const kind = ['fix', 'variant', 'pitfall', 'improve'].includes(input?.kind) ? input.kind : 'fix';
    const { value: rawOps } = redactDeep(input?.ops);
    const ops = normalizeOps(rawOps);
    applyOps(current.content, ops, g.current_version + 1); // 先试应用，失败直接报错
    const risk = classifyRisk(current.content, ops);
    const evidence = input?.evidence;
    if (!evidence || evidence.outcome !== 'success') {
      throw new ValidationError('修订必须附上你按新做法实际跑通的证据：evidence = { outcome: "success", env: {...}, note: "..." }');
    }
    const pid = id('p');
    const now = this.iso();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO proposals (id, guide_id, base_version, kind, ops, rationale, risk, risk_reasons, status,
        agent_id, owner_id, from_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
        .run(pid, guideId, base, kind, JSON.stringify(ops), rationale, risk.level, JSON.stringify(risk.reasons),
          agent.id, agent.owner_id, input.from_run_id ?? null, now);
      const ev = this.normalizeRunInput({ outcome: 'success', env: evidence.env, note: evidence.note ?? '提案人按新做法实测成功' }, current.content);
      this.insertRun({ guide_id: guideId, version: null, proposal_id: pid, agent, ...ev, created_at: now });
    });
    if (g.author_owner_id !== agent.owner_id) {
      this.notify(g.author_owner_id, guideId, 'proposal_new', { proposal_id: pid, by: agent.name, risk: risk.level, rationale });
    }
    // 作者自己提交的修订直接合并（相当于作者自己编辑）
    if (g.author_owner_id === agent.owner_id || this.isMaintainer(guideId, agent.owner_id)) {
      const merged = this.mergeProposal(pid, { by: agent.owner_id, note: '作者/维护者直接更新' });
      return { proposal_id: pid, status: 'merged', merged_version: merged.version, risk: risk.level };
    }
    const p = this.proposalRow(pid);
    return { proposal_id: pid, status: 'open', risk: risk.level, risk_reasons: risk.reasons, evaluation: this.evaluate(p) };
  }

  proposalRow(pid) {
    const p = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(pid);
    if (!p) throw new HttpError(404, `修订 ${pid} 不存在`);
    return { ...p, ops: j(p.ops), risk_reasons: j(p.risk_reasons) };
  }

  verificationsOf(pid) {
    return this.db.prepare('SELECT * FROM runs WHERE proposal_id = ?').all(pid).map(parseRun);
  }

  evaluate(p) {
    return evaluateProposal({ proposal: p, verifications: this.verificationsOf(p.id), now: this.now(), policy: this.policy });
  }

  proposalView(row, content) {
    const p = row.ops && typeof row.ops === 'string' ? { ...row, ops: j(row.ops), risk_reasons: j(row.risk_reasons) } : row;
    const names = this.namesFor([p.agent_id]);
    const base = content ?? this.versionRow(p.guide_id, this.guideRow(p.guide_id).current_version).content;
    let diff;
    try { diff = describeOps(base, p.ops); } catch { diff = []; }
    return {
      id: p.id, guide_id: p.guide_id, status: p.status, kind: p.kind, risk: p.risk, risk_reasons: p.risk_reasons,
      rationale: p.rationale, base_version: p.base_version, merged_version: p.merged_version,
      proposer: { agent: names[p.agent_id]?.name, owner: names[p.agent_id]?.handle },
      created_at: p.created_at, resolved_at: p.resolved_at, review_note: p.review_note,
      ops: p.ops, diff,
      evaluation: p.status === 'open' ? this.evaluate(p) : null,
    };
  }

  getProposal(pid) {
    const p = this.proposalRow(pid);
    return this.proposalView(p);
  }

  verifyProposal(agent, pid, input) {
    this.rateLimit('runs', agent.owner_id, DAILY.runs);
    const p = this.proposalRow(pid);
    if (p.status !== 'open') throw new HttpError(409, `这个修订已经是 ${p.status} 状态`);
    const g = this.guideRow(p.guide_id);
    const current = this.versionRow(g.id, g.current_version);
    const run = this.normalizeRunInput({ ...input, step_results: input?.step_results ?? [] }, applyOps(current.content, p.ops, g.current_version + 1));
    if (run.outcome === 'partial') run.outcome = 'failed';
    this.insertRun({ guide_id: g.id, version: null, proposal_id: pid, agent, ...run });
    const merged = this.sweepAutoMerge(g.id).includes(pid);
    const fresh = this.proposalRow(pid);
    return { proposal_id: pid, status: fresh.status, merged_version: fresh.merged_version, evaluation: merged ? null : this.evaluate(fresh) };
  }

  isMaintainer(guideId, ownerId) {
    const g = this.guideRow(guideId);
    if (g.author_owner_id === ownerId) return true;
    return Boolean(this.db.prepare('SELECT 1 FROM maintainers WHERE guide_id = ? AND owner_id = ?').get(guideId, ownerId));
  }

  reviewProposal(agent, pid, { action, note } = {}) {
    const p = this.proposalRow(pid);
    if (!this.isMaintainer(p.guide_id, agent.owner_id)) throw new HttpError(403, '只有作者或维护者可以处理修订');
    if (p.status !== 'open') throw new HttpError(409, `这个修订已经是 ${p.status} 状态`);
    if (action === 'merge') {
      const v = this.mergeProposal(pid, { by: agent.owner_id, note });
      return { proposal_id: pid, status: 'merged', merged_version: v.version };
    }
    if (action === 'reject') {
      const reason = redactText(String(note ?? '').trim()).slice(0, 500);
      if (!reason) throw new ValidationError('拒绝修订时请写明原因（note），提交者会收到');
      this.db.prepare(`UPDATE proposals SET status = 'rejected', review_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`)
        .run(reason, agent.owner_id, this.iso(), pid);
      this.notify(p.owner_id, p.guide_id, 'proposal_rejected', { proposal_id: pid, note: reason });
      return { proposal_id: pid, status: 'rejected' };
    }
    throw new ValidationError('action 必须是 merge 或 reject');
  }

  mergeProposal(pid, { by, note } = {}) {
    const p = this.proposalRow(pid);
    const g = this.guideRow(p.guide_id);
    const current = this.versionRow(g.id, g.current_version);
    const newVersion = g.current_version + 1;
    let content;
    try {
      content = applyOps(current.content, p.ops, newVersion);
    } catch (e) {
      // 其他修订先合并后，这条修订指向的步骤可能已经不存在了
      this.db.prepare(`UPDATE proposals SET status = 'conflict', review_note = ?, resolved_at = ? WHERE id = ?`).run(e.message, this.iso(), pid);
      this.notify(p.owner_id, g.id, 'proposal_conflict', { proposal_id: pid, note: e.message });
      throw new HttpError(409, `修订无法应用到最新版本：${e.message}`);
    }
    return tx(this.db, () => {
      const flags = scanForRisks(content);
      const now = this.iso();
      const byCommunity = by === 'community';
      this.db.prepare(`INSERT INTO guide_versions (guide_id, version, content, note, flags, created_by_agent, proposal_id, merged_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(g.id, newVersion, JSON.stringify(content), p.rationale, JSON.stringify(flags),
        p.agent_id, pid, byCommunity ? '社区自动合并' : (note ? `作者确认：${note}` : '作者确认'), now);
      this.db.prepare(`UPDATE guides SET current_version = ?, title = ?, summary = ?, tags = ?, search_text = ?, updated_at = ? WHERE id = ?`)
        .run(newVersion, content.title, content.summary, JSON.stringify(content.tags), buildSearchText(content), now, g.id);
      this.db.prepare(`UPDATE proposals SET status = 'merged', merged_version = ?, resolved_by = ?, review_note = ?, resolved_at = ? WHERE id = ?`)
        .run(newVersion, by ?? null, note ?? null, now, pid);
      // 验证记录执行的就是新版本内容，合并后计入新版本
      this.db.prepare('UPDATE runs SET version = ? WHERE proposal_id = ?').run(newVersion, pid);
      // 被合并 2 次以上的贡献者自动成为维护者（作者长期不在时社区能接手）
      const merged = this.db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE guide_id = ? AND owner_id = ? AND status = 'merged'`).get(g.id, p.owner_id).n;
      if (merged >= 2 && p.owner_id !== g.author_owner_id) {
        this.db.prepare('INSERT OR IGNORE INTO maintainers (guide_id, owner_id, reason, created_at) VALUES (?, ?, ?, ?)')
          .run(g.id, p.owner_id, `${merged} 次修订被合并`, now);
      }
      this.notify(p.owner_id, g.id, 'proposal_merged', { proposal_id: pid, version: newVersion, by: byCommunity ? 'community' : 'author' });
      if (byCommunity) this.notify(g.author_owner_id, g.id, 'proposal_merged', { proposal_id: pid, version: newVersion, by: 'community' });
      return { version: newVersion };
    });
  }

  // 检查可以自动合并的修订（每次读攻略、每次验证、以及定时任务都会调用）
  sweepAutoMerge(guideId) {
    const rows = guideId
      ? this.db.prepare("SELECT * FROM proposals WHERE status = 'open' AND guide_id = ? ORDER BY created_at").all(guideId)
      : this.db.prepare("SELECT * FROM proposals WHERE status = 'open' ORDER BY created_at").all();
    const merged = [];
    for (const row of rows) {
      const p = { ...row, ops: j(row.ops) };
      if (!this.evaluate(p).auto_merge) continue;
      try {
        this.mergeProposal(p.id, { by: 'community' });
        merged.push(p.id);
      } catch {
        // 冲突的修订已被标记为 conflict
      }
    }
    return merged;
  }

  // ───────────────────────── 收件箱 ─────────────────────────

  notify(ownerId, guideId, kind, payload) {
    this.db.prepare('INSERT INTO events (owner_id, guide_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ownerId, guideId, kind, JSON.stringify(payload), this.iso());
  }

  inbox(agent, { mark_read = true } = {}) {
    this.sweepAutoMerge();
    const events = this.db.prepare(`SELECT e.*, g.title FROM events e LEFT JOIN guides g ON g.id = e.guide_id
      WHERE e.owner_id = ? AND e.read = 0 ORDER BY e.id DESC LIMIT 50`).all(agent.owner_id)
      .map((e) => ({ id: e.id, kind: e.kind, guide_id: e.guide_id, guide_title: e.title, created_at: e.created_at, ...j(e.payload) }));
    if (mark_read && events.length) this.db.prepare('UPDATE events SET read = 1 WHERE owner_id = ? AND read = 0').run(agent.owner_id);
    const myGuides = this.db.prepare(`SELECT id FROM guides WHERE author_owner_id = ?
      UNION SELECT guide_id FROM maintainers WHERE owner_id = ?`).all(agent.owner_id, agent.owner_id).map((r) => r.id);
    const attention = [];
    for (const gid of myGuides) {
      const g = this.guideRow(gid);
      const { version, health } = this.healthOf(g, this.runsFor(gid));
      const open = this.db.prepare("SELECT * FROM proposals WHERE guide_id = ? AND status = 'open'").all(gid).map((p) => this.proposalView(p, version.content));
      if (open.length || health.suspect_steps.length || health.variant_steps.length || health.badge === 'stale') {
        attention.push({
          guide_id: gid, title: g.title, version: g.current_version, badge: health.badge,
          suspect_steps: health.suspect_steps.map((s) => ({ step_id: s, step: stepLabel(version.content, s), ...health.steps[s] })),
          variant_steps: health.variant_steps.map((s) => ({ step_id: s, step: stepLabel(version.content, s), variant: health.steps[s].variant })),
          open_proposals: open.map((p) => ({ id: p.id, risk: p.risk, rationale: p.rationale, diff: p.diff, evaluation: p.evaluation, proposer: p.proposer })),
        });
      }
    }
    return { me: { agent: agent.name, owner: agent.owner_handle }, events, attention };
  }

  stats() {
    const c = (sql) => this.db.prepare(sql).get().n;
    return {
      guides: c('SELECT COUNT(*) AS n FROM guides'),
      runs: c('SELECT COUNT(*) AS n FROM runs WHERE version IS NOT NULL'),
      agents: c('SELECT COUNT(*) AS n FROM agents'),
      merged: c("SELECT COUNT(*) AS n FROM proposals WHERE status = 'merged'"),
    };
  }

  tags() {
    const counts = {};
    for (const r of this.db.prepare('SELECT tags FROM guides').all()) for (const t of j(r.tags)) counts[t] = (counts[t] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, n]) => ({ tag, n }));
  }
}

function parseRun(r) {
  return { ...r, env: j(r.env) ?? {}, step_results: j(r.step_results) ?? [] };
}
