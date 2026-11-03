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
import { Reputation, START_POINTS, PUBLISH_DEPOSIT, REWARDS, trustOf, tierOf } from './reputation.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const OUTCOMES = new Set(['success', 'partial', 'failed']);
const STEP_STATUS = new Set(['ok', 'drift', 'failed', 'skipped']);
const RATINGS = new Set(['helpful', 'neutral', 'misleading']);
const IMAGE_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': [0x52, 0x49, 0x46, 0x46], 'image/gif': [0x47, 0x49, 0x46] };
const MAX_IMAGE = 1.5 * 1024 * 1024;

const id = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const j = (s) => (s ? JSON.parse(s) : null);

export class Caiguo {
  constructor(db, { now = () => Date.now(), policy } = {}) {
    this.db = db;
    this.now = now;
    this.policy = policy ?? mergePolicy();
    this.rep = new Reputation(db, () => this.iso());
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
        this.rep.add(owner.id, START_POINTS, '新用户初始贡献分', 'start');
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

  // 每日额度由贡献分等级决定
  usedToday(kind, ownerId) {
    const since = this.iso(this.now() - 24 * 3600 * 1000);
    const sql = {
      guides: 'SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ? AND created_at > ?',
      proposals: 'SELECT COUNT(*) AS n FROM proposals WHERE owner_id = ? AND created_at > ?',
      runs: 'SELECT COUNT(*) AS n FROM runs WHERE owner_id = ? AND created_at > ?',
      uploads: 'SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ? AND created_at > ?',
    }[kind];
    return this.db.prepare(sql).get(ownerId, since).n;
  }

  quota(kind, ownerId) {
    const r = this.rep.summary(ownerId);
    const limit = r.quota[kind];
    if (this.usedToday(kind, ownerId) >= limit) {
      const what = { guides: '发布攻略', proposals: '提交修订', runs: '回报执行', uploads: '上传图片' }[kind];
      throw new HttpError(429, `今天${what}的额度已用完（${r.tier_icon}${r.tier_name}每天 ${limit} 次）。分享被别人实测有用的内容可以提升贡献分和额度。`);
    }
    return r;
  }

  // ───────────────────────── 攻略 ─────────────────────────

  publishGuide(agent, input) {
    const r = this.quota('guides', agent.owner_id);
    if (r.points < PUBLISH_DEPOSIT) {
      throw new HttpError(402, `贡献分不足：发布需要 ${PUBLISH_DEPOSIT} 分押金（你现在有 ${r.points} 分）。押金会在攻略第一次被别人实测成功时退回。可以先通过回报执行、验证修订、提交修订来积累贡献分。`);
    }
    const { value: redacted, findings } = redactDeep(input);
    const content = normalizeNewGuide(redacted);
    const flags = scanForRisks(content);
    const similar = this.search(content.title, { limit: 3 }).filter((g) => g.score >= 6);
    const gid = id('g');
    const now = this.iso();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO guides (id, title, summary, tags, source, kind, skill_name, author_agent_id, author_owner_id,
        current_version, search_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(gid, content.title, content.summary, JSON.stringify(content.tags), JSON.stringify(content.source),
          content.kind, content.skill?.name ?? null, agent.id, agent.owner_id, buildSearchText(content), now, now);
      this.rep.add(agent.owner_id, -PUBLISH_DEPOSIT, '发布押金（被他人实测成功后退回）', `deposit:${gid}`, gid);
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
      deposit: PUBLISH_DEPOSIT,
      points_left: Math.round((r.points - PUBLISH_DEPOSIT) * 10) / 10,
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

  // 搜索排序 = 文本相关度 × 质量系数。质量来自真实使用：被多人跑通的排前面，
  // 可能过时/久未验证/未实测的往后放；被多人评为“误导”且没人跑通过的直接折叠。
  search(q, { tag, kind, limit = 20, sort, includeFolded = false } = {}) {
    let rows = this.db.prepare('SELECT * FROM guides').all().map((g) => ({ ...g, tags: j(g.tags), source: j(g.source) }));
    if (tag) rows = rows.filter((g) => g.tags.includes(tag));
    if (kind) rows = rows.filter((g) => g.kind === kind);
    let items = rows.map((g) => ({ g, s: q ? score(q, g) : 1 })).filter((x) => x.s > 0).map(({ g, s }) => {
      const runs = this.runsFor(g.id);
      const { version, health } = this.healthOf(g, runs);
      const ratings = this.ratingsOf(g.id);
      const usage = this.usageOf(g.id);
      const folded = ratings.misleading >= 3 && health.others_success === 0;
      const quality = { fresh: 1.2, new: 0.9, suspect: 0.85, stale: 0.75, unverified: 0.7 }[health.badge] * (1 + Math.log10(1 + health.distinct_runners) * 0.3);
      const open = this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE guide_id = ? AND status = 'open'").get(g.id).n;
      return {
        rank: s * quality,
        folded,
        item: {
          id: g.id, kind: g.kind, title: g.title, summary: g.summary, tags: g.tags, source: g.source,
          skill: version.content.skill,
          cover: version.content.steps.find((st) => st.screenshot)?.screenshot ?? null,
          version: g.current_version, updated_at: g.updated_at, created_at: g.created_at,
          author: this.authorOf(g),
          score: Math.round(s * quality * 10) / 10,
          badge: health.badge,
          last_verified_at: health.last_verified_any_at,
          runs_30d: health.runs_30d,
          success_rate_30d: health.success_rate_30d,
          distinct_runners: health.distinct_runners,
          suspect_steps: health.suspect_steps.length,
          open_proposals: open,
          helpful: ratings.helpful,
          uses_30d: usage.uses_30d,
          agent_reads_30d: usage.agent_reads_30d,
        },
      };
    });
    if (!includeFolded) items = items.filter((x) => !x.folded);
    if (q) {
      items.sort((a, b) => b.rank - a.rank);
      // 相对阈值：明显比最佳结果弱很多的只是沾边，去掉
      const top = items[0]?.rank ?? 0;
      items = items.filter((x) => x.rank >= top * 0.3);
    } else if (sort === 'hot') {
      items.sort((a, b) => (b.item.runs_30d + b.item.uses_30d) - (a.item.runs_30d + a.item.uses_30d));
    } else {
      items.sort((a, b) => Date.parse(b.item.updated_at) - Date.parse(a.item.updated_at));
    }
    return items.slice(0, Math.min(limit, 100)).map((x) => x.item);
  }

  authorOf(g) {
    const a = this.db.prepare(`SELECT a.name, o.handle FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?`).get(g.author_agent_id);
    const r = this.rep.summary(g.author_owner_id);
    return { agent: a?.name, owner: a?.handle, owner_id: g.author_owner_id, points: r.points, tier_name: r.tier_name, tier_icon: r.tier_icon };
  }

  // ───────────────────────── 使用数据 ─────────────────────────
  // 人类往往一直在用却从不评价，所以平台主要靠 Agent 自动产生的“被动信号”：
  // 被哪些 Agent 读过、被调用了多少次、同一个人是否反复使用。只记计数，不记内容。

  recordUse(guideId, viewer, source, { views = 0, uses = 0 } = {}) {
    const day = this.iso().slice(0, 10);
    this.db.prepare(`INSERT INTO usage (guide_id, viewer, source, day, views, uses) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (guide_id, viewer, source, day) DO UPDATE SET views = MIN(1, views + excluded.views), uses = uses + excluded.uses`)
      .run(guideId, viewer, source, day, views ? 1 : 0, uses);
  }

  usageOf(guideId) {
    const since = this.iso(this.now() - 30 * 864e5).slice(0, 10);
    const row = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN source = 'agent' THEN views END), 0) AS agent_reads,
        COALESCE(SUM(CASE WHEN source = 'web' THEN views END), 0) AS human_views,
        COALESCE(SUM(uses), 0) AS uses
      FROM usage WHERE guide_id = ? AND day >= ?`).get(guideId, since);
    const users = this.db.prepare(`SELECT COUNT(DISTINCT viewer) AS n FROM usage WHERE guide_id = ? AND uses > 0 AND day >= ?`).get(guideId, since).n;
    // 回头客：在不同的日子里反复使用（调用或执行）的人
    const repeat = this.db.prepare(`SELECT COUNT(*) AS n FROM (
        SELECT owner_id FROM (
          SELECT viewer AS owner_id, day FROM usage WHERE guide_id = ? AND uses > 0
          UNION SELECT owner_id, substr(created_at, 1, 10) FROM runs WHERE guide_id = ? AND version IS NOT NULL
        ) GROUP BY owner_id HAVING COUNT(DISTINCT day) >= 2)`).get(guideId, guideId).n;
    return { agent_reads_30d: row.agent_reads, human_views_30d: row.human_views, uses_30d: row.uses, users_30d: users, repeat_users: repeat };
  }

  ratingsOf(guideId) {
    const out = { helpful: 0, neutral: 0, misleading: 0 };
    for (const r of this.db.prepare('SELECT rating, COUNT(*) AS n FROM ratings WHERE guide_id = ? GROUP BY rating').all(guideId)) out[r.rating] = r.n;
    return out;
  }

  // 技能被调用次数：插件的钩子在本地计数，定期批量上报（只有技能名和次数）
  reportUsage(agent, items) {
    if (!Array.isArray(items) || items.length > 50) throw new ValidationError('items 必须是数组（最多 50 项）');
    const matched = {};
    for (const it of items) {
      const name = String(it?.skill_name ?? '').slice(0, 64);
      const count = Math.max(0, Math.min(500, Math.floor(Number(it?.count) || 0)));
      if (!name || !count) continue;
      // 插件里的技能名形如 "plugin:skill"，两种写法都尝试匹配
      const find = (n) => this.db.prepare(`SELECT id FROM guides WHERE kind = 'skill' AND skill_name = ? ORDER BY created_at LIMIT 1`).get(n);
      const g = find(name) ?? (name.includes(':') ? find(name.split(':').pop()) : undefined);
      if (!g) continue;
      this.recordUse(g.id, agent.owner_id, 'agent', { uses: count });
      matched[name] = g.id;
    }
    return { matched };
  }

  // ───────────────────────── 图片（图文攻略） ─────────────────────────

  saveUpload(agent, { data, mime }) {
    this.quota('uploads', agent.owner_id);
    if (!IMAGE_TYPES[mime]) throw new ValidationError('只支持 png / jpeg / webp / gif 图片');
    const buf = Buffer.from(String(data ?? ''), 'base64');
    if (!buf.length) throw new ValidationError('图片数据为空');
    if (buf.length > MAX_IMAGE) throw new ValidationError('图片太大（最多 1.5MB），请压缩或裁剪');
    const magic = IMAGE_TYPES[mime];
    if (!magic.every((b, i) => buf[i] === b)) throw new ValidationError('图片内容与类型不符');
    const uid = `${createHash('sha256').update(buf).digest('hex').slice(0, 20)}`;
    this.db.prepare('INSERT OR IGNORE INTO uploads (id, owner_id, mime, bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uid, agent.owner_id, mime, buf.length, buf, this.iso());
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    return { id: uid, path: `/u/${uid}.${ext}`, bytes: buf.length };
  }

  getUpload(uid) {
    const row = this.db.prepare('SELECT mime, data FROM uploads WHERE id = ?').get(uid);
    if (!row) throw new HttpError(404, '图片不存在');
    return row;
  }

  // ───────────────────────── 主页（人类看贡献） ─────────────────────────

  profile(handle) {
    const o = this.db.prepare('SELECT * FROM owners WHERE handle = ?').get(handle);
    if (!o) throw new HttpError(404, `用户 ${handle} 不存在`);
    const guides = this.search('', { limit: 100, includeFolded: true }).filter((g) => g.author.owner_id === o.id);
    const agents = this.db.prepare('SELECT name, created_at FROM agents WHERE owner_id = ?').all(o.id);
    const c = (sql) => this.db.prepare(sql).get(o.id).n;
    return {
      handle: o.handle, created_at: o.created_at,
      reputation: this.rep.summary(o.id),
      history: this.rep.history(o.id, 30),
      agents, guides,
      stats: {
        runs: c('SELECT COUNT(*) AS n FROM runs WHERE owner_id = ? AND proposal_id IS NULL'),
        merged: c("SELECT COUNT(*) AS n FROM proposals WHERE owner_id = ? AND status = 'merged'"),
        verifications: c('SELECT COUNT(*) AS n FROM runs WHERE owner_id = ? AND proposal_id IS NOT NULL'),
      },
    };
  }

  getGuide(guideId, { viewer, source } = {}) {
    this.sweepAutoMerge(guideId);
    const g = this.guideRow(guideId);
    if (viewer) this.recordUse(guideId, viewer, source ?? 'agent', { views: 1 });
    const runs = this.runsFor(guideId);
    const { version, health } = this.healthOf(g, runs);
    const proposals = this.db.prepare(`SELECT * FROM proposals WHERE guide_id = ?
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 20`).all(guideId).map((p) => this.proposalView(p, version.content));
    const versions = this.db.prepare(`SELECT v.version, v.note, v.created_at, v.proposal_id, v.merged_by, a.name AS agent, o.handle AS owner
      FROM guide_versions v JOIN agents a ON a.id = v.created_by_agent JOIN owners o ON o.id = a.owner_id
      WHERE v.guide_id = ? ORDER BY v.version DESC`).all(guideId);
    const names = this.namesFor(runs.map((r) => r.agent_id));
    const recentRuns = runs.filter((r) => r.version !== null).slice(-40).reverse().map((r) => ({
      id: r.id, version: r.version, outcome: r.outcome, env: r.env, note: r.note, rating: r.rating, created_at: r.created_at,
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
      kind: g.kind,
      usage: this.usageOf(guideId),
      ratings: this.ratingsOf(guideId),
    };
  }

  namesFor(agentIds) {
    const out = {};
    const stmt = this.db.prepare('SELECT a.id, a.name, o.handle FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?');
    for (const aid of new Set(agentIds)) out[aid] = stmt.get(aid);
    return out;
  }

  // ───────────────────────── 执行回报 ─────────────────────────

  insertRun({ guide_id, version, proposal_id = null, agent, outcome, env, step_results, note, rating = null, created_at }) {
    const rid = id('r');
    this.db.prepare(`INSERT INTO runs (id, guide_id, version, proposal_id, agent_id, owner_id, outcome, env, step_results, note, rating, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(rid, guide_id, version, proposal_id, agent.id, agent.owner_id, outcome,
      JSON.stringify(env ?? {}), JSON.stringify(step_results ?? []), note ?? null, rating ?? null, created_at ?? this.iso());
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
    this.quota('runs', agent.owner_id);
    const g = this.guideRow(guideId);
    const version = Number(input?.version ?? g.current_version);
    const v = this.versionRow(guideId, version);
    if (!v) throw new ValidationError(`版本 ${version} 不存在（当前是 v${g.current_version}）`);
    const run = this.normalizeRunInput(input, v.content);
    const rating = input?.rating;
    if (rating !== undefined && !RATINGS.has(rating)) throw new ValidationError('rating 只能是 helpful / neutral / misleading');
    const rid = tx(this.db, () => {
      const id2 = this.insertRun({ guide_id: guideId, version, agent, ...run, rating });
      this.recordUse(guideId, agent.owner_id, 'agent', { uses: 1 });
      if (rating) {
        this.db.prepare(`INSERT INTO ratings (guide_id, owner_id, rating, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (guide_id, owner_id) DO UPDATE SET rating = excluded.rating, created_at = excluded.created_at`).run(guideId, agent.owner_id, rating, this.iso());
      }
      this.rewardRun(g, agent, run.outcome, rating);
      return id2;
    });
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

  // 贡献分：只奖励“别人”的真实使用；每个人对每篇攻略的同类信号只算一次；新手的信号打对折
  rewardRun(g, agent, outcome, rating) {
    if (agent.owner_id === g.author_owner_id) return;
    const trust = trustOf(this.rep.points(agent.owner_id));
    const author = g.author_owner_id;
    if (outcome === 'success') {
      this.rep.add(author, REWARDS.firstVerifiedRefund, '押金退回：攻略第一次被他人实测成功', `deposit-refund:${g.id}`, g.id);
      this.rep.add(author, REWARDS.newRunnerSuccess * trust, `攻略被 ${agent.owner_handle ?? '他人'} 实测成功`, `run-success:${g.id}:${agent.owner_id}`, g.id);
    }
    if (rating === 'helpful') this.rep.add(author, REWARDS.helpful * trust, '攻略被评价“有帮助”', `helpful:${g.id}:${agent.owner_id}`, g.id);
    if (rating === 'misleading') this.rep.add(author, REWARDS.misleading * trust, '攻略被评价“有误导”', `misleading:${g.id}:${agent.owner_id}`, g.id);
  }

  propose(agent, guideId, input) {
    this.quota('proposals', agent.owner_id);
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
    this.quota('runs', agent.owner_id);
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
      this.rep.add(p.owner_id, REWARDS.proposalRejected, '修订被作者拒绝', `rejected:${pid}`, p.guide_id);
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
      this.rewardMerge(p, g, newVersion);
      this.notify(p.owner_id, g.id, 'proposal_merged', { proposal_id: pid, version: newVersion, by: byCommunity ? 'community' : 'author' });
      if (byCommunity) this.notify(g.author_owner_id, g.id, 'proposal_merged', { proposal_id: pid, version: newVersion, by: 'community' });
      return { version: newVersion };
    });
  }

  // 修订合并后的贡献分：提交者 +5，验证对了的人 +1，之前报告这些步骤“过时”的人 +1（报告被证实）
  rewardMerge(p, g, newVersion) {
    if (p.owner_id !== g.author_owner_id) this.rep.add(p.owner_id, REWARDS.proposalMerged, '修订被合并', `merged:${p.id}`, g.id);
    const verifiers = new Set(this.verificationsOf(p.id).filter((v) => v.outcome === 'success').map((v) => v.owner_id));
    for (const o of verifiers) if (o !== p.owner_id) this.rep.add(o, REWARDS.verifiedCorrectly, '验证的修订被合并', `verified:${p.id}`, g.id);
    const changed = new Set(p.ops.map((op) => op.step_id).filter(Boolean));
    if (!changed.size) return;
    const since = this.iso(this.now() - 60 * 864e5);
    const reporters = new Set();
    for (const r of this.db.prepare('SELECT * FROM runs WHERE guide_id = ? AND version < ? AND created_at > ?').all(g.id, newVersion, since).map(parseRun)) {
      if (r.step_results.some((sr) => changed.has(sr.step_id) && (sr.status === 'drift' || sr.status === 'failed'))) reporters.add(r.owner_id);
    }
    for (const o of reporters) if (o !== p.owner_id) this.rep.add(o, REWARDS.driftConfirmed, '报告的问题被修订证实', `drift-confirmed:${p.id}`, g.id);
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
    const reputation = this.rep.summary(agent.owner_id);
    const remaining = {};
    for (const k of Object.keys(reputation.quota)) remaining[k] = Math.max(0, reputation.quota[k] - this.usedToday(k, agent.owner_id));
    return { me: { agent: agent.name, owner: agent.owner_handle }, reputation, remaining_today: remaining, recent_points: this.rep.history(agent.owner_id, 5), events, attention };
  }

  // ───────────────────────── 动态（给人类围观 Agent 们在做什么） ─────────────────────────

  activity({ type, limit = 40 } = {}) {
    const guides = {};
    for (const g of this.search('', { limit: 100, includeFolded: true })) guides[g.id] = g;
    const agentName = this.namesFor(this.db.prepare('SELECT id FROM agents').all().map((a) => a.id));
    const items = [];
    const push = (kind, agentId, guideId, created_at, extra = {}) => {
      if (!guides[guideId]) return;
      items.push({ kind, created_at, agent: agentName[agentId]?.name, owner: agentName[agentId]?.handle, guide: guides[guideId], ...extra });
    };
    for (const g of this.db.prepare('SELECT id, author_agent_id, created_at FROM guides ORDER BY created_at DESC LIMIT 60').all()) {
      push('published', g.author_agent_id, g.id, g.created_at);
    }
    for (const r of this.db.prepare(`SELECT * FROM runs WHERE proposal_id IS NULL AND version IS NOT NULL ORDER BY created_at DESC LIMIT 120`).all().map(parseRun)) {
      if (r.note === '作者发布时的实操') continue;
      const v = this.versionRow(r.guide_id, r.version);
      const problems = r.step_results.filter((x) => x.status === 'drift' || x.status === 'failed')
        .map((x) => ({ ...x, step: v ? stepLabel(v.content, x.step_id) : x.step_id }));
      push(problems.length ? 'problem' : 'run', r.agent_id, r.guide_id, r.created_at, { outcome: r.outcome, problems, note: r.note, rating: r.rating, env: r.env });
    }
    for (const p of this.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 60').all()) {
      push('proposal', p.agent_id, p.guide_id, p.created_at, { rationale: p.rationale, risk: p.risk, status: p.status });
    }
    for (const v of this.db.prepare(`SELECT * FROM guide_versions WHERE version > 1 ORDER BY created_at DESC LIMIT 60`).all()) {
      push('merged', v.created_by_agent, v.guide_id, v.created_at, { version: v.version, note: v.note, merged_by: v.merged_by });
    }
    const filter = { problems: ['problem'], changes: ['proposal', 'merged'], new: ['published'] }[type];
    return items
      .filter((x) => !filter || filter.includes(x.kind))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit);
  }

  topContributors(limit = 5) {
    return this.db.prepare(`SELECT o.handle, SUM(l.delta) AS points FROM ledger l JOIN owners o ON o.id = l.owner_id
      GROUP BY l.owner_id ORDER BY points DESC LIMIT ?`).all(limit).map((r) => ({ ...r, points: Math.round(r.points * 10) / 10, ...tierBrief(r.points) }));
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

function tierBrief(points) {
  const t = tierOf(points);
  return { tier_name: t.name, tier_icon: t.icon };
}

function parseRun(r) {
  return { ...r, env: j(r.env) ?? {}, step_results: j(r.step_results) ?? [] };
}
