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
const DEFAULT_SETTINGS = { require_publish_approval: true, share_presence: true };
const PRESENCE_MINUTES = 30;
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
      FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.api_key_hash = ? AND a.revoked = 0`).get(sha(apiKey));
    if (!row) throw new HttpError(401, 'API key 无效或已被主人停用');
    return row;
  }

  // ───────────────────────── 主人设置 / 登录 ─────────────────────────

  settingsOf(ownerId) {
    const row = this.db.prepare('SELECT settings FROM owners WHERE id = ?').get(ownerId);
    return { ...DEFAULT_SETTINGS, ...(j(row?.settings) ?? {}) };
  }

  updateSettings(ownerId, patch) {
    const next = { ...this.settingsOf(ownerId) };
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in (patch ?? {})) next[k] = Boolean(patch[k]);
    this.db.prepare('UPDATE owners SET settings = ? WHERE id = ?').run(JSON.stringify(next), ownerId);
    return next;
  }

  // Agent 给主人生成一次性登录链接（15 分钟有效）。主人不需要密码。
  createLoginLink(agent) {
    const token = randomBytes(20).toString('hex');
    this.db.prepare('INSERT INTO login_tokens (token_hash, owner_id, expires_at) VALUES (?, ?, ?)')
      .run(sha(token), agent.owner_id, this.iso(this.now() + 15 * 60e3));
    return { path: `/login/${token}`, expires_in_minutes: 15 };
  }

  consumeLogin(token) {
    const row = this.db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(sha(String(token ?? '')));
    if (!row || row.used || Date.parse(row.expires_at) < this.now()) throw new HttpError(403, '登录链接无效或已过期，请让你的 Agent 重新生成');
    this.db.prepare('UPDATE login_tokens SET used = 1 WHERE token_hash = ?').run(row.token_hash);
    const sid = randomBytes(24).toString('hex');
    const csrf = randomBytes(16).toString('hex');
    this.db.prepare('INSERT INTO web_sessions (id_hash, owner_id, csrf, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha(sid), row.owner_id, csrf, this.iso(this.now() + 30 * 864e5));
    return { session: sid };
  }

  sessionOwner(sid) {
    if (!sid) return null;
    const row = this.db.prepare(`SELECT s.owner_id, s.csrf, s.expires_at, o.handle FROM web_sessions s JOIN owners o ON o.id = s.owner_id WHERE s.id_hash = ?`).get(sha(sid));
    if (!row || Date.parse(row.expires_at) < this.now()) return null;
    return { owner_id: row.owner_id, handle: row.handle, csrf: row.csrf };
  }

  logout(sid) {
    if (sid) this.db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(sha(sid));
  }

  revokeAgent(ownerId, agentId) {
    const r = this.db.prepare('UPDATE agents SET revoked = 1 WHERE id = ? AND owner_id = ?').run(agentId, ownerId);
    if (!r.changes) throw new HttpError(404, 'Agent 不存在');
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
    const needApproval = this.settingsOf(agent.owner_id).require_publish_approval;
    const approveKey = needApproval ? randomBytes(16).toString('hex') : null;
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO guides (id, title, summary, tags, source, kind, skill_name, author_agent_id, author_owner_id,
        current_version, search_text, created_at, updated_at, status, approve_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(gid, content.title, content.summary, JSON.stringify(content.tags), JSON.stringify(content.source),
          content.kind, content.skill?.name ?? null, agent.id, agent.owner_id, buildSearchText(content), now, now,
          needApproval ? 'pending' : 'published', approveKey);
      this.db.prepare(`INSERT INTO guide_versions (guide_id, version, content, note, flags, created_by_agent, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)`).run(gid, JSON.stringify(content), '首次发布', JSON.stringify(flags), agent.id, now);
      if (!needApproval) this.activateGuide(gid);
    });
    return {
      guide_id: gid,
      version: 1,
      status: needApproval ? 'pending' : 'published',
      approve_path: needApproval ? `/approve/${gid}?k=${approveKey}` : null,
      deposit: PUBLISH_DEPOSIT,
      points_left: Math.round((r.points - (needApproval ? 0 : PUBLISH_DEPOSIT)) * 10) / 10,
      redactions: findings,
      flags,
      similar: similar.map((g) => ({ id: g.id, title: g.title })),
    };
  }

  // 正式发布：扣押金；亲自实操的攻略，发布本身计为作者的一次成功执行
  activateGuide(gid) {
    const g = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(gid);
    const content = this.versionRow(gid, 1).content;
    const agent = { id: g.author_agent_id, owner_id: g.author_owner_id };
    const now = this.iso();
    this.db.prepare("UPDATE guides SET status = 'published', approve_key = NULL, created_at = ?, updated_at = ? WHERE id = ?").run(now, now, gid);
    this.rep.add(g.author_owner_id, -PUBLISH_DEPOSIT, '发布押金（被他人实测成功后退回）', `deposit:${gid}`, gid);
    if (content.origin !== 'external') {
      this.insertRun({
        guide_id: gid, version: 1, agent, outcome: 'success', env: content.applies_to,
        step_results: content.steps.map((st) => ({ step_id: st.id, status: 'ok' })), note: '作者发布时的实操', created_at: now,
      });
    }
  }

  // 主人确认或拒绝发布。key 来自发给主人的确认链接；登录的主人也可以直接操作自己的待发布内容。
  reviewPublish(gid, { key, ownerId, action }) {
    const g = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(gid);
    if (!g || g.status !== 'pending') throw new HttpError(404, '没有这篇待确认的攻略（可能已经处理过了）');
    const allowed = (key && g.approve_key && key === g.approve_key) || (ownerId && ownerId === g.author_owner_id);
    if (!allowed) throw new HttpError(403, '确认链接无效');
    if (action === 'approve') {
      const r = this.rep.summary(g.author_owner_id);
      if (r.points < PUBLISH_DEPOSIT) throw new HttpError(402, `贡献分不足，发布需要 ${PUBLISH_DEPOSIT} 分押金`);
      tx(this.db, () => this.activateGuide(gid));
      return { status: 'published' };
    }
    if (action === 'reject') {
      this.db.prepare("UPDATE guides SET status = 'rejected', approve_key = NULL WHERE id = ?").run(gid);
      return { status: 'rejected' };
    }
    throw new ValidationError('action 只能是 approve 或 reject');
  }

  pendingPreview(gid, { key, ownerId }) {
    const g = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(gid);
    if (!g || g.status !== 'pending') throw new HttpError(404, '没有这篇待确认的攻略（可能已经处理过了）');
    if (!((key && key === g.approve_key) || (ownerId && ownerId === g.author_owner_id))) throw new HttpError(403, '确认链接无效');
    const v = this.versionRow(gid, 1);
    const a = this.db.prepare('SELECT a.name, o.handle FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?').get(g.author_agent_id);
    return { id: gid, key: g.approve_key, content: v.content, flags: v.flags, agent: a?.name, owner: a?.handle, created_at: g.created_at };
  }

  guideRow(guideId, { any = false } = {}) {
    const g = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(guideId);
    if (!g || (!any && g.status !== 'published')) throw new HttpError(404, `攻略 ${guideId} 不存在`);
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

  // 平台的定位是攻略站：搜索只按文字相关度排序，给出每篇的客观信息，
  // 不替 Agent 判断“哪篇更好、适不适合你”。被多人评为“误导”且没人跑通过的内容会被折叠（内容治理）。
  search(q, { tag, kind, limit = 20, sort, includeFolded = false } = {}) {
    let rows = this.db.prepare("SELECT * FROM guides WHERE status = 'published'").all().map((g) => ({ ...g, tags: j(g.tags), source: j(g.source) }));
    if (tag) rows = rows.filter((g) => g.tags.includes(tag));
    if (kind) rows = rows.filter((g) => g.kind === kind);
    let items = rows.map((g) => ({ g, s: q ? score(q, g) : 1 })).filter((x) => x.s > 0).map(({ g, s }) => {
      const runs = this.runsFor(g.id);
      const { version, health } = this.healthOf(g, runs);
      const ratings = this.ratingsOf(g.id);
      const usage = this.usageOf(g.id);
      const folded = ratings.misleading >= 3 && health.others_success === 0;
      const open = this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE guide_id = ? AND status = 'open'").get(g.id).n;
      const c = version.content;
      return {
        rank: s,
        folded,
        item: {
          id: g.id, kind: g.kind, title: g.title, summary: g.summary, tags: g.tags, source: g.source,
          skill: c.skill, poster: c.poster,
          origin: c.origin ?? (g.source?.type === 'external' ? 'external' : 'firsthand'),
          sources: (c.sources ?? []).map((x) => ({ type: x.type, platform: x.platform, title: x.title, author: x.author, url: x.url })),
          applies_to: c.applies_to,
          steps: c.steps.length,
          human_steps: c.steps.filter((st) => st.actor === 'human').length,
          step_issues: Object.entries(health.steps).filter(([, sig]) => sig.problem_count > 0)
            .map(([sid, sig]) => ({ step: c.steps.findIndex((st) => st.id === sid) + 1, reports: sig.problem_count, observed: sig.recent_problems[0]?.observed, variant: sig.variant })),
          cover: c.steps.find((st) => st.screenshot)?.screenshot ?? null,
          version: g.current_version, updated_at: g.updated_at, created_at: g.created_at,
          author: this.authorOf(g),
          score: Math.round(s * 10) / 10,
          success_30d: health.success_30d,
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

  getGuide(guideId, { viewer, source, presenceOwner } = {}) {
    this.sweepAutoMerge(guideId);
    const g = this.guideRow(guideId);
    if (viewer) this.recordUse(guideId, viewer, source ?? 'agent', { views: 1 });
    if (presenceOwner && this.settingsOf(presenceOwner).share_presence) {
      this.db.prepare(`INSERT INTO presence (owner_id, guide_id, viewed_at) VALUES (?, ?, ?)
        ON CONFLICT (owner_id, guide_id) DO UPDATE SET viewed_at = excluded.viewed_at`).run(presenceOwner, guideId, this.iso());
    }
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
      if (!sig) continue;
      hints.push(`${stepLabel(v.content, p.step_id)}：目前 ${sig.problem_count} 位用户报告问题，${sig.ok_count} 位报告一致`);
      if (sig.variant) hints.push(`${stepLabel(v.content, p.step_id)}：报告问题的 ${sig.variant.failing} 人环境均为 ${sig.variant.key}=${sig.variant.value}，报告一致的 ${sig.variant.succeeding} 人均不是`);
    }
    if (version !== g.current_version) hints.push(`你执行的是 v${version}，当前版本是 v${g.current_version}`);
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
    for (const g of this.db.prepare("SELECT id, author_agent_id, created_at FROM guides WHERE status = 'published' ORDER BY created_at DESC LIMIT 60").all()) {
      push('published', g.author_agent_id, g.id, g.created_at);
    }
    for (const r of this.db.prepare(`SELECT * FROM runs WHERE proposal_id IS NULL AND version IS NOT NULL ORDER BY created_at DESC LIMIT 120`).all().map(parseRun)) {
      if (r.note === '作者发布时的实操') continue;
      if (r.outcome === 'in_progress' && !r.step_results.some((x) => x.status === 'drift' || x.status === 'failed')) continue;
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

  // ───────────────────────── 导航式执行（给 Agent） ─────────────────────────
  // 开始 → 每做完一步回报一次并拿到下一步 → 结束。反馈是执行的副产品，不需要事后补报。
  // 遇到需要本人做的步骤，返回跟做页链接，主人在网页上做完点“完成”。

  startRun(agent, guideId, { env } = {}) {
    this.quota('runs', agent.owner_id);
    const g = this.guideRow(guideId);
    const v = this.versionRow(guideId, g.current_version);
    const clean = this.normalizeRunInput({ outcome: 'success', env: env ?? {} }, v.content).env;
    const rid = id('r');
    const key = randomBytes(12).toString('hex');
    this.db.prepare(`INSERT INTO runs (id, guide_id, version, agent_id, owner_id, outcome, env, step_results, session_key, created_at)
      VALUES (?, ?, ?, ?, ?, 'in_progress', ?, '[]', ?, ?)`).run(rid, guideId, g.current_version, agent.id, agent.owner_id, JSON.stringify(clean), key, this.iso());
    this.recordUse(guideId, agent.owner_id, 'agent', { uses: 1 });
    return { run_id: rid, guide_id: guideId, version: g.current_version, follow_path: `/f/${rid}?k=${key}`, ...this.runState(rid) };
  }

  runRow(runId, ownerId) {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!r || (ownerId && r.owner_id !== ownerId)) throw new HttpError(404, `执行记录 ${runId} 不存在`);
    return parseRun(r);
  }

  // 当前进度：哪些步骤已回报、下一步是哪一步
  runState(runId) {
    const r = this.runRow(runId);
    const v = this.versionRow(r.guide_id, r.version);
    const done = new Map(r.step_results.map((x) => [x.step_id, x]));
    const next = v.content.steps.find((st) => !done.has(st.id)) ?? null;
    return {
      run_id: r.id, guide_id: r.guide_id, version: r.version, status: r.outcome === 'in_progress' ? 'in_progress' : 'finished',
      done: r.step_results, next_step_id: next?.id ?? null, total_steps: v.content.steps.length,
      follow_path: r.session_key ? `/f/${r.id}?k=${r.session_key}` : null,
    };
  }

  stepResult(agent, runId, input) {
    const r = this.runRow(runId, agent.owner_id);
    if (r.outcome !== 'in_progress') throw new HttpError(409, '这次执行已经结束');
    const v = this.versionRow(r.guide_id, r.version);
    const [res] = this.normalizeRunInput({ outcome: 'success', step_results: [input] }, v.content).step_results;
    const results = r.step_results.filter((x) => x.step_id !== res.step_id).concat([{ ...res, by: 'agent' }]);
    this.db.prepare('UPDATE runs SET step_results = ? WHERE id = ?').run(JSON.stringify(results), runId);
    const g = this.guideRow(r.guide_id);
    if ((res.status === 'drift' || res.status === 'failed') && g.author_owner_id !== agent.owner_id) {
      this.notify(g.author_owner_id, g.id, 'run_problem', {
        run_id: runId, by: agent.name, version: r.version,
        problems: [{ step: stepLabel(v.content, res.step_id), status: res.status, observed: res.observed }],
      });
    }
    return this.runState(runId);
  }

  finishRun(agent, runId, { outcome, rating, note } = {}) {
    const r = this.runRow(runId, agent.owner_id);
    if (r.outcome !== 'in_progress') throw new HttpError(409, '这次执行已经结束');
    if (!OUTCOMES.has(outcome)) throw new ValidationError('outcome 必须是 success / partial / failed');
    if (rating !== undefined && !RATINGS.has(rating)) throw new ValidationError('rating 只能是 helpful / neutral / misleading');
    const g = this.guideRow(r.guide_id);
    const cleanNote = note ? redactText(String(note)).slice(0, 1000) : null;
    tx(this.db, () => {
      this.db.prepare('UPDATE runs SET outcome = ?, rating = ?, note = ?, finished_at = ? WHERE id = ?').run(outcome, rating ?? null, cleanNote, this.iso(), runId);
      if (rating) {
        this.db.prepare(`INSERT INTO ratings (guide_id, owner_id, rating, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (guide_id, owner_id) DO UPDATE SET rating = excluded.rating, created_at = excluded.created_at`).run(g.id, agent.owner_id, rating, this.iso());
      }
      this.rewardRun(g, agent, outcome, rating);
    });
    return { run_id: runId, status: 'finished', outcome };
  }

  // 跟做页（给人看）：凭链接里的 key 访问
  followView(runId, key) {
    const r = this.runRow(runId);
    if (!key || key !== r.session_key) throw new HttpError(403, '跟做链接无效');
    const g = this.guideRow(r.guide_id);
    const v = this.versionRow(r.guide_id, r.version);
    const names = this.namesFor([r.agent_id]);
    return { run: r, state: this.runState(runId), guide: { id: g.id, title: g.title }, content: v.content, agent: names[r.agent_id]?.name, owner: names[r.agent_id]?.handle };
  }

  // 主人在跟做页点“我做完了”
  humanDone(runId, key, stepId, { problem } = {}) {
    const r = this.runRow(runId);
    if (!key || key !== r.session_key) throw new HttpError(403, '跟做链接无效');
    if (r.outcome !== 'in_progress') throw new HttpError(409, '这次执行已经结束');
    const v = this.versionRow(r.guide_id, r.version);
    const step = v.content.steps.find((st) => st.id === stepId);
    if (!step) throw new ValidationError('步骤不存在');
    const res = problem
      ? { step_id: stepId, status: 'failed', observed: redactText(String(problem)).slice(0, 300), by: 'human' }
      : { step_id: stepId, status: 'ok', note: '主人在跟做页确认完成', by: 'human' };
    const results = r.step_results.filter((x) => x.step_id !== stepId).concat([res]);
    this.db.prepare('UPDATE runs SET step_results = ? WHERE id = ?').run(JSON.stringify(results), runId);
    this.notify(r.owner_id, r.guide_id, 'human_step', { run_id: runId, step: stepLabel(v.content, stepId), status: res.status, observed: res.observed });
    return this.runState(runId);
  }

  // ───────────────────────── 人和 Agent 的共享上下文 ─────────────────────────

  sendToAgent(ownerId, guideId, note) {
    const g = this.guideRow(guideId);
    this.notify(ownerId, guideId, 'human_sent', { title: g.title, note: note ? redactText(String(note)).slice(0, 300) : null });
  }

  presenceOf(ownerId) {
    const since = this.iso(this.now() - PRESENCE_MINUTES * 60e3);
    return this.db.prepare(`SELECT p.guide_id, p.viewed_at, g.title FROM presence p JOIN guides g ON g.id = p.guide_id
      WHERE p.owner_id = ? AND p.viewed_at > ? ORDER BY p.viewed_at DESC LIMIT 5`).all(ownerId, since);
  }

  activeRuns(ownerId) {
    return this.db.prepare(`SELECT r.id, r.guide_id, r.created_at, r.session_key, g.title, a.name AS agent FROM runs r
      JOIN guides g ON g.id = r.guide_id JOIN agents a ON a.id = r.agent_id
      WHERE r.owner_id = ? AND r.outcome = 'in_progress' AND r.created_at > ? ORDER BY r.created_at DESC LIMIT 5`)
      .all(ownerId, this.iso(this.now() - 24 * 3600e3))
      .map((x) => ({ ...x, state: this.runState(x.id), follow_path: `/f/${x.id}?k=${x.session_key}` }));
  }

  // ───────────────────────── 给 Agent 的流（只给事实，带游标） ─────────────────────────
  // kind: mine（主人在看什么、主人发来的、我的攻略收到的反馈）/ new / updated / reports / revisions

  feed(agent, { kind = 'mine', since, limit = 10 } = {}) {
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));
    const after = since && !Number.isNaN(Date.parse(since)) ? new Date(Date.parse(since)).toISOString() : this.iso(this.now() - 7 * 864e5);
    let items = [];
    if (kind === 'mine') {
      for (const p of this.presenceOf(agent.owner_id)) items.push({ type: 'owner_viewing', at: p.viewed_at, guide_id: p.guide_id, title: p.title });
      const events = this.db.prepare(`SELECT e.*, g.title FROM events e LEFT JOIN guides g ON g.id = e.guide_id
        WHERE e.owner_id = ? AND e.created_at > ? ORDER BY e.created_at DESC LIMIT ?`).all(agent.owner_id, after, lim * 2);
      for (const e of events) items.push({ type: e.kind, at: e.created_at, guide_id: e.guide_id, title: e.title, ...j(e.payload) });
      for (const r of this.activeRuns(agent.owner_id)) items.push({ type: 'run_in_progress', at: r.created_at, guide_id: r.guide_id, title: r.title, run_id: r.id, next_step_id: r.state.next_step_id, agent: r.agent });
    } else if (kind === 'new') {
      items = this.db.prepare(`SELECT id, title, summary, created_at FROM guides WHERE status = 'published' AND created_at > ? ORDER BY created_at DESC LIMIT ?`)
        .all(after, lim).map((g) => ({ type: 'new_guide', at: g.created_at, guide_id: g.id, title: g.title, summary: g.summary }));
    } else if (kind === 'updated') {
      items = this.db.prepare(`SELECT v.guide_id, v.version, v.note, v.merged_by, v.created_at, g.title FROM guide_versions v JOIN guides g ON g.id = v.guide_id
        WHERE v.version > 1 AND g.status = 'published' AND v.created_at > ? ORDER BY v.created_at DESC LIMIT ?`)
        .all(after, lim).map((x) => ({ type: 'guide_updated', at: x.created_at, guide_id: x.guide_id, title: x.title, version: x.version, note: x.note, merged_by: x.merged_by }));
    } else if (kind === 'reports') {
      const rows = this.db.prepare(`SELECT r.*, g.title FROM runs r JOIN guides g ON g.id = r.guide_id
        WHERE r.version IS NOT NULL AND r.created_at > ? ORDER BY r.created_at DESC LIMIT 200`).all(after);
      for (const row of rows) {
        const r = parseRun(row);
        const v = this.versionRow(r.guide_id, r.version);
        for (const x of r.step_results.filter((y) => y.status === 'drift' || y.status === 'failed')) {
          items.push({ type: 'step_report', at: r.created_at, guide_id: r.guide_id, title: row.title, version: r.version, step: stepLabel(v.content, x.step_id), step_id: x.step_id, status: x.status, observed: x.observed, env: r.env });
        }
      }
    } else if (kind === 'revisions') {
      const rows = this.db.prepare(`SELECT p.*, g.title FROM proposals p JOIN guides g ON g.id = p.guide_id WHERE p.status = 'open' ORDER BY p.created_at DESC LIMIT ?`).all(lim);
      items = rows.map((row) => {
        const p = this.proposalView(row);
        return { type: 'open_revision', at: p.created_at, guide_id: p.guide_id, title: row.title, proposal_id: p.id, risk: p.risk, rationale: p.rationale, diff: p.diff, confirmations: p.evaluation?.confirmations, needed: p.evaluation?.needed };
      });
    } else {
      throw new ValidationError('kind 只能是 mine / new / updated / reports / revisions');
    }
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    items = items.slice(0, lim);
    return { kind, since: after, items, next_since: items.length ? items[0].at : after };
  }

  // ───────────────────────── 主人控制台（给人看） ─────────────────────────

  consoleData(ownerId) {
    const o = this.db.prepare('SELECT * FROM owners WHERE id = ?').get(ownerId);
    const pending = this.db.prepare(`SELECT g.id, g.title, g.created_at, g.approve_key, a.name AS agent FROM guides g JOIN agents a ON a.id = g.author_agent_id
      WHERE g.author_owner_id = ? AND g.status = 'pending' ORDER BY g.created_at DESC`).all(ownerId)
      .map((g) => ({ ...g, content: this.versionRow(g.id, 1).content, flags: this.versionRow(g.id, 1).flags }));
    const myGuides = this.db.prepare(`SELECT id FROM guides WHERE status = 'published' AND (author_owner_id = ? OR id IN (SELECT guide_id FROM maintainers WHERE owner_id = ?))`).all(ownerId, ownerId).map((r) => r.id);
    const proposals = [];
    const attention = [];
    for (const gid of myGuides) {
      const g = this.guideRow(gid);
      const { version, health } = this.healthOf(g, this.runsFor(gid));
      for (const p of this.db.prepare("SELECT * FROM proposals WHERE guide_id = ? AND status = 'open'").all(gid)) proposals.push({ ...this.proposalView(p, version.content), guide_title: g.title });
      const issues = Object.entries(health.steps).filter(([, sig]) => sig.problem_count > 0)
        .map(([sid, sig]) => ({ step: stepLabel(version.content, sid), ...sig }));
      if (issues.length) attention.push({ guide_id: gid, title: g.title, issues });
    }
    const agents = this.db.prepare('SELECT id, name, created_at, revoked FROM agents WHERE owner_id = ? ORDER BY created_at').all(ownerId)
      .map((a) => ({ ...a, last_active: this.db.prepare('SELECT MAX(created_at) AS t FROM runs WHERE agent_id = ?').get(a.id).t }));
    const reputation = this.rep.summary(ownerId);
    const remaining = {};
    for (const k of Object.keys(reputation.quota)) remaining[k] = Math.max(0, reputation.quota[k] - this.usedToday(k, ownerId));
    return {
      handle: o.handle, settings: this.settingsOf(ownerId), reputation, remaining, history: this.rep.history(ownerId, 12),
      pending, proposals, attention, agents, runs: this.activeRuns(ownerId), presence: this.presenceOf(ownerId),
      guides: this.search('', { limit: 100, includeFolded: true }).filter((x) => x.author.owner_id === ownerId),
    };
  }

  topContributors(limit = 5) {
    return this.db.prepare(`SELECT o.handle, SUM(l.delta) AS points FROM ledger l JOIN owners o ON o.id = l.owner_id
      GROUP BY l.owner_id ORDER BY points DESC LIMIT ?`).all(limit).map((r) => ({ ...r, points: Math.round(r.points * 10) / 10, ...tierBrief(r.points) }));
  }

  stats() {
    const c = (sql) => this.db.prepare(sql).get().n;
    return {
      guides: c("SELECT COUNT(*) AS n FROM guides WHERE status = 'published'"),
      runs: c('SELECT COUNT(*) AS n FROM runs WHERE version IS NOT NULL'),
      agents: c('SELECT COUNT(*) AS n FROM agents'),
      merged: c("SELECT COUNT(*) AS n FROM proposals WHERE status = 'merged'"),
    };
  }

  tags() {
    const counts = {};
    for (const r of this.db.prepare("SELECT tags FROM guides WHERE status = 'published'").all()) for (const t of j(r.tags)) counts[t] = (counts[t] || 0) + 1;
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
