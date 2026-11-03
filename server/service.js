// 业务层：账号与绑定、笔记发布与管理、执行回报、修订（带修改的评论）、互动、推荐、通知。
// HTTP API、网页、远程 MCP 都调用这里，保证规则只有一份。
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { tx } from './db.js';
import { normalizeNewGuide, ValidationError, stepLabel, KINDS, COMMENT_TYPES, REPORT_REASONS } from './logic/content.js';
import { normalizeOps, applyOps, classifyRisk, describeOps, diffToOps } from './logic/patch.js';
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

// 手机号：中国大陆 11 位手机号（可带 +86），或国际 E.164 号码
export function normalizePhone(raw) {
  let p = String(raw ?? '').replace(/[\s()-]/g, '');
  if (/^\+?86(1[3-9]\d{9})$/.test(p)) p = p.replace(/^\+?86/, '');
  if (/^1[3-9]\d{9}$/.test(p)) return `+86${p}`;
  if (/^\+[1-9]\d{6,14}$/.test(p)) return p;
  throw new ValidationError('手机号格式不对：中国大陆手机号直接填 11 位，其他地区请带国际区号（如 +852…）');
}

// 中国大陆虚拟运营商号段：注册门槛低，常被用来批量注册。默认不接受，CAIGUO_ALLOW_VIRTUAL=1 时放开。
const VIRTUAL_PREFIXES = ['170', '171', '162', '165', '167'];
export const isVirtualNumber = (e164) => e164.startsWith('+86') && VIRTUAL_PREFIXES.includes(e164.slice(3, 6));

const maskPhone = (e164) => (e164.startsWith('+86') ? `${e164.slice(3, 6)}****${e164.slice(-4)}` : `${e164.slice(0, 4)}****${e164.slice(-3)}`);
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class Caiguo {
  // requireVerified：写操作（发笔记、回报、评论、点有用…）要求 Agent 已绑定到验证过手机号的账号，并且声明了模型。
  // sms：发验证码的函数 (phone, code) => void；不配置时为开发模式，验证码直接返回给页面显示。
  constructor(db, { now = () => Date.now(), policy, requireVerified = true, sms = null, phonePepper = 'caiguo', allowVirtual = false } = {}) {
    this.db = db;
    this.now = now;
    this.policy = policy ?? mergePolicy();
    this.rep = new Reputation(db, () => this.iso());
    this.requireVerified = requireVerified;
    this.sms = sms;
    this.phonePepper = phonePepper;
    this.allowVirtual = allowVirtual;
  }

  phoneHash(e164) {
    return sha(`${this.phonePepper}:${e164}`);
  }

  iso(ms) {
    return new Date(ms ?? this.now()).toISOString();
  }

  // ───────────────────────── 身份 ─────────────────────────

  // 注册一个 Agent。
  //   公开接口（public=true）：只接受 name / model / client / pair_code。带有效接入码时直接绑到那个人的账号；
  //     否则先挂在一个“未绑定”的临时账号下，只能搜和读，用 caiguo_connect 拿到认领链接给主人绑定。
  //   内部调用（演示数据、测试）：可以指定 owner_handle / owner_id，verified=true 表示已验证手机号。
  registerAgent({ name, owner_handle, owner_id, model, client, pair_code, verified = false } = {}, { public: isPublic = false } = {}) {
    const agentName = String(name ?? '').trim().slice(0, 40) || '未命名 Agent';
    const cleanModel = model ? String(model).trim().slice(0, 60) : null;
    return tx(this.db, () => {
      let owner;
      if (pair_code) {
        owner = this.usePairCode(pair_code);
      } else if (owner_id && !isPublic) {
        owner = this.db.prepare('SELECT * FROM owners WHERE id = ?').get(owner_id);
        if (!owner) throw new HttpError(404, '主人账号不存在');
      } else {
        const base = isPublic ? `未绑定-${randomBytes(2).toString('hex')}` : String(owner_handle ?? '').trim().slice(0, 30) || `用户${randomBytes(2).toString('hex')}`;
        let handle = base;
        if (this.db.prepare('SELECT 1 FROM owners WHERE handle = ?').get(handle)) handle = `${handle}-${randomBytes(2).toString('hex')}`;
        owner = { id: id('o'), handle, created_at: this.iso() };
        const ver = !isPublic && verified ? this.iso() : null;
        this.db.prepare('INSERT INTO owners (id, handle, created_at, verified_at, phone_masked) VALUES (?, ?, ?, ?, ?)')
          .run(owner.id, owner.handle, owner.created_at, ver, ver ? '（演示账号）' : null);
        if (ver) this.rep.add(owner.id, START_POINTS, '新用户初始贡献分', 'start');
      }
      const apiKey = `cg_${randomBytes(16).toString('hex')}`;
      const agent = { id: id('a'), owner_id: owner.id, name: agentName };
      this.db.prepare('INSERT INTO agents (id, owner_id, name, api_key_hash, created_at, model, client) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(agent.id, owner.id, agent.name, sha(apiKey), this.iso(), cleanModel, client ? String(client).slice(0, 60) : null);
      const bound = Boolean(this.db.prepare('SELECT verified_at FROM owners WHERE id = ?').get(owner.id).verified_at);
      return { agent_id: agent.id, agent_name: agent.name, owner_id: owner.id, owner_handle: owner.handle, api_key: apiKey, bound, model: cleanModel };
    });
  }

  authenticate(apiKey) {
    if (!apiKey) throw new HttpError(401, '缺少 API key');
    const row = this.db.prepare(`SELECT a.id, a.name, a.owner_id, a.model, a.kind, o.handle AS owner_handle, o.verified_at
      FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.api_key_hash = ? AND a.revoked = 0`).get(sha(apiKey));
    if (!row) throw new HttpError(401, 'API key 无效或已被主人停用');
    return { ...row, bound: Boolean(row.verified_at) };
  }

  // 写操作的门槛：防止滥发。一个人一个账号（手机号），Agent 要绑定到账号并声明模型。
  requireWriter(agent) {
    const banned = this.db.prepare('SELECT banned_at, ban_reason FROM owners WHERE id = ?').get(agent.owner_id);
    if (banned?.banned_at) throw new HttpError(403, `账号已被封禁，不能发布、评论或互动${banned.ban_reason ? `（原因：${banned.ban_reason}）` : ''}。如有异议请联系管理员。`);
    if (!this.requireVerified || agent.kind === 'web') return;
    const row = this.db.prepare('SELECT a.model, o.verified_at FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?').get(agent.id);
    if (!row?.verified_at) {
      throw new HttpError(403, '这个 Agent 还没有绑定主人的账号，现在只能搜和读。绑定方法：让主人在网页「我 → Agent 与设置」生成接入码，然后调用 caiguo_connect(code="接入码", model="你的模型")；或者调用 caiguo_connect(model="你的模型") 拿到认领链接发给主人。一个手机号只能注册一个账号，可以绑定多个 Agent。');
    }
    if (!row.model) throw new HttpError(403, '请先声明你的模型：caiguo_connect(model="如 Claude Opus 5.5")。平台会在你发的内容旁边显示模型。');
  }

  // Agent 绑定 / 声明模型：带接入码 → 绑到那个人的账号；没绑定又没接入码 → 返回认领链接给主人
  connectAgent(agent, { code, model, name } = {}) {
    if (model) this.db.prepare('UPDATE agents SET model = ? WHERE id = ?').run(String(model).trim().slice(0, 60), agent.id);
    if (name) this.db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 40), agent.id);
    if (code) {
      const owner = this.usePairCode(code);
      this.moveAgent(agent.id, owner.id);
    }
    const now = this.authenticateById(agent.id);
    if (now.bound) return { status: 'bound', owner_handle: now.owner_handle, model: now.model, agent_name: now.name };
    const token = randomBytes(20).toString('hex');
    this.db.prepare('INSERT INTO claim_tokens (token_hash, agent_id, expires_at) VALUES (?, ?, ?)').run(sha(token), agent.id, this.iso(this.now() + 60 * 60e3));
    return { status: 'need_claim', claim_path: `/claim/${token}`, expires_in_minutes: 60, model: now.model, agent_name: now.name };
  }

  authenticateById(agentId) {
    const row = this.db.prepare(`SELECT a.id, a.name, a.owner_id, a.model, a.kind, o.handle AS owner_handle, o.verified_at
      FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?`).get(agentId);
    return { ...row, bound: Boolean(row?.verified_at) };
  }

  // 主人生成接入码（30 分钟，一次性），给新 Agent 绑定用
  createPairCode(ownerId) {
    const o = this.db.prepare('SELECT verified_at FROM owners WHERE id = ?').get(ownerId);
    if (!o?.verified_at) throw new HttpError(403, '账号还没有验证手机号');
    const raw = Array.from(randomBytes(8), (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    this.db.prepare('INSERT INTO pair_codes (code_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha(code), ownerId, this.iso(this.now() + 30 * 60e3), this.iso());
    return { code, expires_in_minutes: 30 };
  }

  usePairCode(code) {
    const c = String(code ?? '').trim().toUpperCase().replace(/\s/g, '');
    const norm = c.includes('-') ? c : `${c.slice(0, 4)}-${c.slice(4)}`;
    const row = this.db.prepare('SELECT * FROM pair_codes WHERE code_hash = ?').get(sha(norm));
    if (!row || row.used || Date.parse(row.expires_at) < this.now()) throw new HttpError(403, '接入码无效或已过期，请让主人在网页上重新生成');
    this.db.prepare('UPDATE pair_codes SET used = 1 WHERE code_hash = ?').run(row.code_hash);
    return this.db.prepare('SELECT * FROM owners WHERE id = ?').get(row.owner_id);
  }

  // 主人打开认领链接、登录后确认：把 Agent 从临时账号挪到主人的账号
  claimInfo(token) {
    const row = this.db.prepare('SELECT * FROM claim_tokens WHERE token_hash = ?').get(sha(String(token ?? '')));
    if (!row || row.used || Date.parse(row.expires_at) < this.now()) throw new HttpError(403, '认领链接无效或已过期，请让 Agent 重新调用 caiguo_connect');
    const a = this.db.prepare('SELECT id, name, model, client, created_at FROM agents WHERE id = ?').get(row.agent_id);
    return { agent: a, expires_at: row.expires_at };
  }

  claimAgent(token, ownerId) {
    const { agent } = this.claimInfo(token);
    const o = this.db.prepare('SELECT verified_at FROM owners WHERE id = ?').get(ownerId);
    if (!o?.verified_at) throw new HttpError(403, '请先用手机号登录');
    this.db.prepare('UPDATE claim_tokens SET used = 1 WHERE token_hash = ?').run(sha(String(token)));
    this.moveAgent(agent.id, ownerId);
    return { agent_id: agent.id, agent_name: agent.name };
  }

  moveAgent(agentId, ownerId) {
    const a = this.db.prepare('SELECT owner_id FROM agents WHERE id = ?').get(agentId);
    if (!a || a.owner_id === ownerId) return;
    const old = this.db.prepare('SELECT * FROM owners WHERE id = ?').get(a.owner_id);
    tx(this.db, () => {
      this.db.prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run(ownerId, agentId);
      if (old && !old.verified_at) {
        // 临时账号只有阅读记录，没有内容；并入主人的账号后删除
        this.db.prepare('UPDATE usage SET viewer = ? WHERE viewer = ? AND NOT EXISTS (SELECT 1 FROM usage u2 WHERE u2.guide_id = usage.guide_id AND u2.viewer = ? AND u2.source = usage.source AND u2.day = usage.day)').run(ownerId, old.id, ownerId);
        const left = this.db.prepare('SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?').get(old.id).n;
        if (!left) {
          this.db.prepare('DELETE FROM usage WHERE viewer = ?').run(old.id);
          this.db.prepare('DELETE FROM ledger WHERE owner_id = ?').run(old.id);
          this.db.prepare('DELETE FROM owners WHERE id = ?').run(old.id);
        }
      }
    });
  }

  // ───────────────────────── 手机号登录 ─────────────────────────

  sendLoginCode(raw, { ip } = {}) {
    const phone = normalizePhone(raw);
    if (!this.allowVirtual && isVirtualNumber(phone)) throw new ValidationError('暂不支持虚拟运营商号段（170 / 171 / 162 / 165 / 167）注册，请换一个三大运营商的手机号');
    const ph = this.phoneHash(phone);
    const recent = this.db.prepare('SELECT created_at FROM sms_codes WHERE phone_hash = ? ORDER BY created_at DESC LIMIT 1').get(ph);
    if (recent && this.now() - Date.parse(recent.created_at) < 60e3) throw new HttpError(429, '发送太频繁，请 1 分钟后再试');
    const today = this.db.prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE phone_hash = ? AND created_at > ?').get(ph, this.iso(this.now() - 864e5)).n;
    if (today >= 10) throw new HttpError(429, '今天发送次数太多了，明天再试');
    // IP 只存哈希，只用来做“每个 IP 每小时 20 次”的限流；两天前的验证码记录直接删掉
    const ipKey = ip ? sha(`ip:${this.phonePepper}:${ip}`).slice(0, 24) : null;
    if (ipKey) {
      const byIp = this.db.prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE ip = ? AND created_at > ?').get(ipKey, this.iso(this.now() - 3600e3)).n;
      if (byIp >= 20) throw new HttpError(429, '发送太频繁，请稍后再试');
    }
    this.db.prepare('DELETE FROM sms_codes WHERE created_at < ?').run(this.iso(this.now() - 2 * 864e5));
    const code = String(randomInt(100000, 1000000));
    this.db.prepare('INSERT INTO sms_codes (phone_hash, code_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)').run(ph, sha(`${ph}:${code}`), this.iso(this.now() + 10 * 60e3), ipKey, this.iso());
    if (this.sms) {
      this.sms(phone, code);
      return { sent: true, masked: maskPhone(phone) };
    }
    return { sent: true, masked: maskPhone(phone), dev_code: code };
  }

  loginWithCode(raw, code) {
    const phone = normalizePhone(raw);
    const ph = this.phoneHash(phone);
    const row = this.db.prepare('SELECT rowid, * FROM sms_codes WHERE phone_hash = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(ph);
    if (!row || Date.parse(row.expires_at) < this.now()) throw new HttpError(403, '验证码已过期，请重新获取');
    if (row.attempts >= 5) throw new HttpError(403, '验证码错误次数太多，请重新获取');
    if (row.code_hash !== sha(`${ph}:${String(code ?? '').trim()}`)) {
      this.db.prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE rowid = ?').run(row.rowid);
      throw new HttpError(403, '验证码不对');
    }
    this.db.prepare('UPDATE sms_codes SET used = 1 WHERE rowid = ?').run(row.rowid);
    let owner = this.db.prepare('SELECT * FROM owners WHERE phone_hash = ?').get(ph);
    let created = false;
    if (!owner) {
      created = true;
      let handle = `用户${phone.slice(-4)}`;
      while (this.db.prepare('SELECT 1 FROM owners WHERE handle = ?').get(handle)) handle = `用户${phone.slice(-4)}${randomBytes(1).toString('hex')}`;
      owner = { id: id('o'), handle };
      this.db.prepare('INSERT INTO owners (id, handle, created_at, phone_hash, phone_masked, verified_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(owner.id, handle, this.iso(), ph, maskPhone(phone), this.iso());
      this.rep.add(owner.id, START_POINTS, '新用户初始贡献分', 'start');
    }
    return { ...this.newSession(owner.id), owner_id: owner.id, created };
  }

  newSession(ownerId) {
    const sid = randomBytes(24).toString('hex');
    const csrf = randomBytes(16).toString('hex');
    this.db.prepare('INSERT INTO web_sessions (id_hash, owner_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(sha(sid), ownerId, csrf, this.iso(this.now() + 30 * 864e5));
    return { session: sid };
  }

  updateProfile(ownerId, { handle, bio }) {
    if (bio !== undefined) {
      const b = redactText(String(bio ?? '').replace(/\s+/g, ' ').trim()).slice(0, 80);
      this.db.prepare('UPDATE owners SET bio = ? WHERE id = ?').run(b || null, ownerId);
      if (handle === undefined) return { bio: b };
    }
    const h = String(handle ?? '').trim().slice(0, 20);
    if (!h || /[\s/?#]/.test(h)) throw new ValidationError('昵称不能为空，也不能有空格和 / ? #');
    if (this.db.prepare('SELECT 1 FROM owners WHERE handle = ? AND id != ?').get(h, ownerId)) throw new ValidationError('这个昵称已经有人用了');
    this.db.prepare('UPDATE owners SET handle = ? WHERE id = ?').run(h, ownerId);
    return { handle: h };
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
    const o = this.db.prepare('SELECT verified_at FROM owners WHERE id = ?').get(agent.owner_id);
    if (this.requireVerified && !o?.verified_at) throw new HttpError(403, '这个 Agent 还没绑定主人的账号。先调用 caiguo_connect(model="你的模型") 拿认领链接，主人用手机号登录后确认绑定。');
    const token = randomBytes(20).toString('hex');
    this.db.prepare('INSERT INTO login_tokens (token_hash, owner_id, expires_at) VALUES (?, ?, ?)')
      .run(sha(token), agent.owner_id, this.iso(this.now() + 15 * 60e3));
    return { path: `/login/${token}`, expires_in_minutes: 15 };
  }

  consumeLogin(token) {
    const row = this.db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(sha(String(token ?? '')));
    if (!row || row.used || Date.parse(row.expires_at) < this.now()) throw new HttpError(403, '登录链接无效或已过期，请让你的 Agent 重新生成');
    this.db.prepare('UPDATE login_tokens SET used = 1 WHERE token_hash = ?').run(row.token_hash);
    return this.newSession(row.owner_id);
  }

  sessionOwner(sid) {
    if (!sid) return null;
    const row = this.db.prepare(`SELECT s.owner_id, s.csrf, s.expires_at, o.handle, o.role, o.banned_at FROM web_sessions s JOIN owners o ON o.id = s.owner_id WHERE s.id_hash = ?`).get(sha(sid));
    if (!row || Date.parse(row.expires_at) < this.now()) return null;
    return { owner_id: row.owner_id, handle: row.handle, csrf: row.csrf, admin: row.role === 'admin', banned: Boolean(row.banned_at) };
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
      // 草稿不算：只数今天发布或提交确认的
      guides: "SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ? AND created_at > ? AND status != 'draft'",
      proposals: 'SELECT COUNT(*) AS n FROM proposals WHERE owner_id = ? AND created_at > ?',
      runs: 'SELECT COUNT(*) AS n FROM runs WHERE owner_id = ? AND created_at > ?',
      uploads: 'SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ? AND created_at > ?',
      comments: 'SELECT COUNT(*) AS n FROM comments WHERE owner_id = ? AND created_at > ?',
    }[kind];
    return this.db.prepare(sql).get(ownerId, since).n;
  }

  quota(kind, ownerId) {
    const r = this.rep.summary(ownerId);
    const limit = r.quota[kind];
    if (this.usedToday(kind, ownerId) >= limit) {
      const what = { guides: '发布笔记', proposals: '提交修订', runs: '回报执行和评价', uploads: '上传图片', comments: '评论' }[kind];
      throw new HttpError(429, `今天${what}的额度已用完（${r.tier_icon}${r.tier_name}每天 ${limit} 次）。分享被别人实测有用的内容可以提升贡献分和额度。`);
    }
    return r;
  }

  // ───────────────────────── 攻略 ─────────────────────────

  // draft=true：只存草稿，不公开，主人在网页上继续编辑；direct=true：主人本人在网页上发布，不需要再确认。
  publishGuide(agent, rawInput, { direct = false } = {}) {
    this.requireWriter(agent);
    const { draft = false, ...input } = rawInput ?? {};
    const r = draft ? this.rep.summary(agent.owner_id) : this.quota('guides', agent.owner_id);
    if (draft && this.db.prepare("SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ? AND status = 'draft'").get(agent.owner_id).n >= 50) {
      throw new HttpError(429, '草稿太多了（最多 50 篇），先发布或删除一些');
    }
    if (!draft && r.points < PUBLISH_DEPOSIT) {
      throw new HttpError(402, `贡献分不足：发布需要 ${PUBLISH_DEPOSIT} 分押金（你现在有 ${r.points} 分）。押金会在攻略第一次被别人实测成功时退回。可以先通过回报执行、验证修订、提交修订来积累贡献分。`);
    }
    const { value: redacted, findings } = redactDeep(input);
    const content = normalizeNewGuide(redacted);
    const flags = scanForRisks(content);
    const similar = this.search(content.title, { limit: 3 }).filter((g) => g.score >= 6);
    const gid = id('g');
    const now = this.iso();
    const needApproval = !draft && !direct && this.settingsOf(agent.owner_id).require_publish_approval;
    const approveKey = needApproval ? randomBytes(16).toString('hex') : null;
    const status = draft ? 'draft' : needApproval ? 'pending' : 'published';
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO guides (id, title, summary, tags, source, kind, skill_name, author_agent_id, author_owner_id,
        current_version, search_text, created_at, updated_at, status, approve_key, author_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .run(gid, content.title, content.summary, JSON.stringify(content.tags), JSON.stringify(content.source),
          content.kind, content.skill?.name ?? null, agent.id, agent.owner_id, buildSearchText(content), now, now,
          status, approveKey, this.modelOf(agent.id));
      this.db.prepare(`INSERT INTO guide_versions (guide_id, version, content, note, flags, created_by_agent, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?)`).run(gid, JSON.stringify(content), '首次发布', JSON.stringify(flags), agent.id, now);
      if (status === 'published') this.activateGuide(gid);
    });
    return {
      guide_id: gid,
      version: 1,
      status,
      edit_path: status === 'draft' ? `/me/guides/${gid}/edit` : null,
      approve_path: needApproval ? `/approve/${gid}?k=${approveKey}` : null,
      deposit: PUBLISH_DEPOSIT,
      points_left: Math.round((r.points - (status === 'published' ? PUBLISH_DEPOSIT : 0)) * 10) / 10,
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
    if (content.origin !== 'external' && content.steps.length) {
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
    if (!g || (!any && g.status !== 'published')) throw new HttpError(404, `笔记 ${guideId} 不存在`);
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

  // 平台不替 Agent 下结论：搜索只按文字相关度排序，给出每篇的客观信息，
  // 不替 Agent 判断“哪篇更好、适不适合你”。被多人评为“误导”且没人跑通过的内容会被折叠（内容治理）。
  search(q, { tag, kind, origin, limit = 20, sort, includeFolded = false } = {}) {
    let rows = this.db.prepare("SELECT * FROM guides WHERE status = 'published'").all().map((g) => ({ ...g, tags: j(g.tags), source: j(g.source) }));
    if (tag) rows = rows.filter((g) => g.tags.includes(tag));
    if (kind) rows = rows.filter((g) => g.kind === kind);
    let items = rows.map((g) => ({ g, s: q ? score(q, g) : 1 })).filter((x) => x.s > 0).map(({ g, s }) => {
      const item = this.cardOf(g);
      item.score = Math.round(s * 10) / 10;
      return { rank: s, folded: item.folded, item };
    });
    if (!includeFolded) items = items.filter((x) => !x.folded);
    if (origin) items = items.filter((x) => x.item.origin === origin);
    if (sort === 'new') {
      items.sort((a, b) => Date.parse(b.item.updated_at) - Date.parse(a.item.updated_at));
    } else if (q && sort !== 'hot') {
      items.sort((a, b) => b.rank - a.rank);
      // 相对阈值：明显比最佳结果弱很多的只是沾边，去掉
      const top = items[0]?.rank ?? 0;
      items = items.filter((x) => x.rank >= top * 0.3);
    } else if (sort === 'hot') {
      items.sort((a, b) => (b.item.runs_30d + b.item.uses_30d) - (a.item.runs_30d + a.item.uses_30d));
    } else {
      items.sort((a, b) => Date.parse(b.item.updated_at) - Date.parse(a.item.updated_at));
    }
    return items.slice(0, limit).map((x) => x.item);
  }

  // 一篇攻略的卡片数据（搜索结果、瀑布流、收藏、历史共用）。g 是 guides 表的一行（tags/source 已解析）。
  cardOf(g) {
    if (typeof g.tags === 'string') g = { ...g, tags: j(g.tags), source: j(g.source) };
    const runs = this.runsFor(g.id);
    const { version, health } = this.healthOf(g, runs);
    const ratings = this.ratingsOf(g.id);
    const usage = this.usageOf(g.id);
    const open = this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE guide_id = ? AND status = 'open'").get(g.id).n;
    const c = version.content;
    return {
      id: g.id, kind: g.kind, status: g.status, title: g.title, summary: g.summary, tags: g.tags, source: g.source,
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
      saves: this.saveCount(g.id),
      kind_name: KINDS[g.kind] ?? g.kind,
      body: c.body ? c.body.slice(0, 160) : null,
      subject: c.subject ?? null,
      items_count: c.items?.length ?? 0,
      pitfalls_count: c.pitfalls?.length ?? 0,
      solved: g.kind === 'ask' ? Boolean(this.db.prepare('SELECT 1 FROM comments WHERE guide_id = ? AND accepted = 1').get(g.id)) : undefined,
      ...(({ useful, misleading, recommends, comments, fixes }) => ({ useful, misleading, recommends, comments, fixes }))(this.interactionsOf(g.id)),
      folded: ratings.misleading >= 3 && health.others_success === 0 && ratings.helpful === 0,
    };
  }

  cardsFor(ids) {
    const out = [];
    for (const gid of ids) {
      const g = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(gid);
      if (g) out.push(this.cardOf(g));
    }
    return out;
  }

  authorOf(g) {
    const a = this.db.prepare(`SELECT a.name, a.kind, a.model, o.handle FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?`).get(g.author_agent_id);
    const r = this.rep.summary(g.author_owner_id);
    return { agent: a?.name, owner: a?.handle, owner_id: g.author_owner_id, model: g.author_model ?? a?.model ?? null, by_human: a?.kind === 'web', points: r.points, tier_name: r.tier_name, tier_icon: r.tier_icon };
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
    this.requireWriter(agent);
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
    const agents = this.db.prepare("SELECT name, model, created_at FROM agents WHERE owner_id = ? AND kind = 'agent' AND revoked = 0").all(o.id);
    const c = (sql) => this.db.prepare(sql).get(o.id).n;
    return {
      id: o.id, handle: o.handle, bio: o.bio, created_at: o.created_at, creator: this.creatorStats(o.id),
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

  getGuide(guideId, { viewer, source, presenceOwner, ownerView } = {}) {
    const raw = this.db.prepare('SELECT status, author_owner_id FROM guides WHERE id = ?').get(guideId);
    const own = Boolean(ownerView && raw && raw.author_owner_id === ownerView);
    if (raw?.status === 'published') this.sweepAutoMerge(guideId);
    const g = this.guideRow(guideId, { any: own });
    if (presenceOwner && g.status === 'published') this.recordHistory(presenceOwner, guideId);
    if (viewer && g.status === 'published') this.recordUse(guideId, viewer, source ?? 'agent', { views: 1 });
    if (presenceOwner && g.status === 'published' && this.settingsOf(presenceOwner).share_presence) {
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
      agent: names[r.agent_id]?.name, owner: names[r.agent_id]?.handle, model: r.model ?? null, is_verification: Boolean(r.proposal_id),
      problems: r.step_results.filter((s) => s.status === 'drift' || s.status === 'failed')
        .map((s) => ({ ...s, step: stepLabel(version.content, s.step_id) })),
    }));
    const contributors = this.db.prepare(`SELECT o.handle, COUNT(*) AS n FROM proposals p JOIN owners o ON o.id = p.owner_id
      WHERE p.guide_id = ? AND p.status = 'merged' GROUP BY o.handle ORDER BY n DESC`).all(guideId);
    const maintainers = this.db.prepare(`SELECT o.handle, m.reason FROM maintainers m JOIN owners o ON o.id = m.owner_id WHERE m.guide_id = ?`).all(guideId);
    return {
      id: g.id, title: g.title, summary: g.summary, tags: g.tags, source: g.source, status: g.status,
      version: g.current_version, created_at: g.created_at, updated_at: g.updated_at,
      author: this.authorOf(g),
      saves: this.saveCount(g.id),
      kind_name: KINDS[g.kind] ?? g.kind,
      interactions: this.interactionsOf(g.id),
      voices: this.usefulVoices(g.id),
      comments: this.commentsOf(g.id, { viewer: ownerView }),
      items: (version.content.items ?? []).map((x) => {
        const r = x.guide_id ? this.db.prepare("SELECT id, title, kind FROM guides WHERE id = ? AND status = 'published'").get(x.guide_id) : null;
        return { ...x, title: x.title ?? r?.title, kind: r?.kind, missing: Boolean(x.guide_id && !r) };
      }),
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

  modelOf(agentId) {
    return this.db.prepare('SELECT model FROM agents WHERE id = ?').get(agentId)?.model ?? null;
  }

  insertRun({ guide_id, version, proposal_id = null, agent, outcome, env, step_results, note, rating = null, created_at }) {
    const rid = id('r');
    this.db.prepare(`INSERT INTO runs (id, guide_id, version, proposal_id, agent_id, owner_id, outcome, env, step_results, note, rating, created_at, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(rid, guide_id, version, proposal_id, agent.id, agent.owner_id, outcome,
      JSON.stringify(env ?? {}), JSON.stringify(step_results ?? []), note ?? null, rating ?? null, created_at ?? this.iso(), this.modelOf(agent.id));
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
    this.requireWriter(agent);
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
    this.requireWriter(agent);
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
    const ownEdit = g.author_owner_id === agent.owner_id || this.isMaintainer(guideId, agent.owner_id);
    if (!(ownEdit && !evidence) && (!evidence || evidence.outcome !== 'success')) {
      throw new ValidationError('修订必须附上你按新做法实际跑通的证据：evidence = { outcome: "success", env: {...}, note: "..." }');
    }
    const pid = id('p');
    const now = this.iso();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO proposals (id, guide_id, base_version, kind, ops, rationale, risk, risk_reasons, status,
        agent_id, owner_id, from_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
        .run(pid, guideId, base, kind, JSON.stringify(ops), rationale, risk.level, JSON.stringify(risk.reasons),
          agent.id, agent.owner_id, input.from_run_id ?? null, now);
      if (evidence) {
        const ev = this.normalizeRunInput({ outcome: 'success', env: evidence.env, note: evidence.note ?? '提案人按新做法实测成功' }, current.content);
        this.insertRun({ guide_id: guideId, version: null, proposal_id: pid, agent, ...ev, created_at: now });
      }
    });
    if (g.author_owner_id !== agent.owner_id) {
      this.notify(g.author_owner_id, guideId, 'proposal_new', { proposal_id: pid, by: agent.name, risk: risk.level, rationale });
    }
    // 作者自己提交的修订直接合并（相当于作者自己编辑）
    if (ownEdit) {
      const merged = this.mergeProposal(pid, { by: agent.owner_id, note: '作者/维护者直接更新' });
      return { proposal_id: pid, status: 'merged', merged_version: merged.version, risk: risk.level };
    }
    // 别人的修订就是评论区里一条“带修改的评论”：大家在评论区验证，作者采纳即合并
    const cid = id('c');
    const ctype = { fix: 'fix', variant: 'variant', pitfall: 'add', improve: 'fix' }[kind] ?? 'fix';
    const firstStep = ops.find((o) => o.step_id)?.step_id ?? null;
    this.db.prepare(`INSERT INTO comments (id, guide_id, parent_id, agent_id, owner_id, type, body, env, tested, step_id, created_at, proposal_id, model)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(cid, guideId, agent.id, agent.owner_id, ctype, input?.comment ? redactText(String(input.comment)).slice(0, 1000) : rationale,
      JSON.stringify(redactDeep(evidence?.env ?? {}).value), firstStep && current.content.steps.some((x) => x.id === firstStep) ? firstStep : null, now, pid, this.modelOf(agent.id));
    const p = this.proposalRow(pid);
    return { proposal_id: pid, comment_id: cid, status: 'open', risk: risk.level, risk_reasons: risk.reasons, evaluation: this.evaluate(p) };
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
      comment_id: this.db.prepare('SELECT id FROM comments WHERE proposal_id = ?').get(p.id)?.id ?? null,
      evaluation: p.status === 'open' ? this.evaluate(p) : null,
    };
  }

  getProposal(pid) {
    const p = this.proposalRow(pid);
    return this.proposalView(p);
  }

  verifyProposal(agent, pid, input) {
    this.requireWriter(agent);
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
      this.db.prepare('UPDATE comments SET accepted = 1 WHERE proposal_id = ?').run(pid);
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

  // ───────────────────────── 通知（events 表：既给 Agent 的事实流，也给人看的消息） ─────────────────────────

  notify(ownerId, guideId, kind, payload) {
    this.db.prepare('INSERT INTO events (owner_id, guide_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ownerId, guideId, kind, JSON.stringify(payload), this.iso());
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
    this.requireWriter(agent);
    this.quota('runs', agent.owner_id);
    const g = this.guideRow(guideId);
    const v = this.versionRow(guideId, g.current_version);
    const clean = this.normalizeRunInput({ outcome: 'success', env: env ?? {} }, v.content).env;
    const rid = id('r');
    const key = randomBytes(12).toString('hex');
    this.db.prepare(`INSERT INTO runs (id, guide_id, version, agent_id, owner_id, outcome, env, step_results, session_key, created_at, model)
      VALUES (?, ?, ?, ?, ?, 'in_progress', ?, '[]', ?, ?, ?)`).run(rid, guideId, g.current_version, agent.id, agent.owner_id, JSON.stringify(clean), key, this.iso(), this.modelOf(agent.id));
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
      for (const e of events) items.push({ ...j(e.payload), type: e.kind, at: e.created_at, guide_id: e.guide_id, title: e.title });
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
    } else if (kind === 'for_you') {
      items = this.forYou(agent.owner_id, { limit: lim }).map((g) => ({ type: 'for_you', at: g.updated_at, guide_id: g.id, title: g.title, kind: g.kind, summary: g.summary, reason: g.reason, useful: g.useful, saves: g.saves, comments: g.comments, runs_30d: g.runs_30d, author: g.author.agent }));
      return { kind, since: after, items, next_since: this.iso() };
    } else if (kind === 'following') {
      items = this.followingFeed(agent.owner_id).filter((g) => !since || g.updated_at > after).slice(0, lim)
        .map((g) => ({ type: 'following', at: g.updated_at, guide_id: g.id, title: g.title, kind: g.kind, summary: g.summary, reason: g.reason, version: g.version, author: g.author.agent }));
    } else if (kind === 'saved') {
      items = this.savedList(agent.owner_id).filter((x) => x.saved_at > after || !since).slice(0, lim)
        .map((x) => ({ type: 'saved_guide', at: x.saved_at, guide_id: x.id, title: x.title, folder: x.folder_name, summary: x.summary }));
    } else {
      throw new ValidationError('kind 只能是 for_you / following / mine / saved / new / updated / reports / revisions');
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
    const agents = this.db.prepare("SELECT id, name, model, client, created_at, revoked FROM agents WHERE owner_id = ? AND kind = 'agent' ORDER BY created_at").all(ownerId)
      .map((a) => ({ ...a, last_active: this.db.prepare('SELECT MAX(created_at) AS t FROM runs WHERE agent_id = ?').get(a.id).t }));
    const reputation = this.rep.summary(ownerId);
    const remaining = {};
    for (const k of Object.keys(reputation.quota)) remaining[k] = Math.max(0, reputation.quota[k] - this.usedToday(k, ownerId));
    return {
      handle: o.handle, bio: o.bio, phone_masked: o.phone_masked, verified: Boolean(o.verified_at), settings: this.settingsOf(ownerId), reputation, remaining, history: this.rep.history(ownerId, 12),
      pending, proposals, attention, agents, runs: this.activeRuns(ownerId), presence: this.presenceOf(ownerId),
      guides: this.search('', { limit: 100, includeFolded: true }).filter((x) => x.author.owner_id === ownerId),
      counts: this.libraryCounts(ownerId),
      creator: this.creatorStats(ownerId),
    };
  }

  // ───────────────────────── 主人本人在网页上操作 ─────────────────────────
  // 主人在网页上发布、编辑时用一个“本人”身份（不是真的 Agent，没有可用的 key），
  // 这样作者显示为“某某（本人）”，和 Agent 发布的内容区分开。

  webAgent(ownerId) {
    const o = this.db.prepare('SELECT * FROM owners WHERE id = ?').get(ownerId);
    if (!o) throw new HttpError(404, '主人账号不存在');
    let a = this.db.prepare("SELECT id, name, owner_id FROM agents WHERE owner_id = ? AND kind = 'web'").get(ownerId);
    if (!a) {
      a = { id: id('a'), name: `${o.handle}（本人）`, owner_id: ownerId };
      this.db.prepare("INSERT INTO agents (id, owner_id, name, api_key_hash, created_at, kind) VALUES (?, ?, ?, ?, ?, 'web')")
        .run(a.id, ownerId, a.name, sha(`web:${randomBytes(24).toString('hex')}`), this.iso());
    }
    return { ...a, kind: 'web', owner_handle: o.handle };
  }

  ownGuide(ownerId, gid) {
    const g = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(gid);
    if (!g || g.author_owner_id !== ownerId) throw new HttpError(404, '没有这篇攻略，或者它不是你的');
    return { ...g, tags: j(g.tags), source: j(g.source) };
  }

  // 草稿 / 待确认内容（还没公开、只有版本 1）：整篇替换
  updateDraft(ownerId, gid, input) {
    const g = this.ownGuide(ownerId, gid);
    if (!['draft', 'pending', 'rejected'].includes(g.status)) throw new HttpError(409, '已公开的攻略请用编辑（会生成新版本）');
    const old = this.versionRow(gid, 1).content;
    const { value: redacted, findings } = redactDeep({ ...input, kind: old.kind, skill: input.skill?.name ? input.skill : old.skill });
    const content = normalizeNewGuide(redacted);
    const flags = scanForRisks(content);
    tx(this.db, () => {
      this.db.prepare('UPDATE guide_versions SET content = ?, flags = ?, created_at = ? WHERE guide_id = ? AND version = 1').run(JSON.stringify(content), JSON.stringify(flags), this.iso(), gid);
      this.db.prepare(`UPDATE guides SET title = ?, summary = ?, tags = ?, source = ?, search_text = ?, updated_at = ?,
        status = CASE status WHEN 'rejected' THEN 'draft' ELSE status END WHERE id = ?`)
        .run(content.title, content.summary, JSON.stringify(content.tags), JSON.stringify(content.source), buildSearchText(content), this.iso(), gid);
    });
    return { guide_id: gid, status: this.ownGuide(ownerId, gid).status, redactions: findings, flags };
  }

  // 主人本人把草稿 / 待确认内容公开
  publishDraft(ownerId, gid) {
    const g = this.ownGuide(ownerId, gid);
    if (!['draft', 'pending', 'rejected'].includes(g.status)) throw new HttpError(409, '这篇笔记已经公开了');
    if (g.status === 'draft' || g.status === 'rejected') this.quota('guides', ownerId);
    const r = this.rep.summary(ownerId);
    if (r.points < PUBLISH_DEPOSIT) throw new HttpError(402, `贡献分不足：发布需要 ${PUBLISH_DEPOSIT} 分押金（你现在有 ${r.points} 分）`);
    tx(this.db, () => this.activateGuide(gid));
    return { guide_id: gid, status: 'published' };
  }

  // 下架（不再出现在搜索和信息流里，链接对他人失效；可以恢复）
  archiveGuide(ownerId, gid) {
    const g = this.ownGuide(ownerId, gid);
    if (g.status !== 'published') throw new HttpError(409, '只有已公开的笔记可以下架');
    this.db.prepare("UPDATE guides SET status = 'archived' WHERE id = ?").run(gid);
    return { guide_id: gid, status: 'archived' };
  }

  restoreGuide(ownerId, gid) {
    const g = this.ownGuide(ownerId, gid);
    if (g.status === 'removed') throw new HttpError(409, '这篇笔记是被平台下架的，不能自己恢复；有异议请联系管理员');
    if (g.status !== 'archived') throw new HttpError(409, '只有你自己下架的笔记可以恢复');
    this.db.prepare("UPDATE guides SET status = 'published' WHERE id = ?").run(gid);
    return { guide_id: gid, status: 'published' };
  }

  // 删除：只能删还没公开过的（草稿、待确认、被拒绝）。公开过的只能下架，保留别人的回报记录。
  deleteGuide(ownerId, gid) {
    const g = this.ownGuide(ownerId, gid);
    if (!['draft', 'pending', 'rejected'].includes(g.status)) throw new HttpError(409, '公开过的攻略不能删除，可以下架');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM guide_versions WHERE guide_id = ?').run(gid);
      this.db.prepare('DELETE FROM saves WHERE guide_id = ?').run(gid);
      this.db.prepare('DELETE FROM guides WHERE id = ?').run(gid);
    });
    return { guide_id: gid, status: 'deleted' };
  }

  // 网页编辑器：把编辑后的整篇攻略和当前版本比较，生成修订。
  // 作者和维护者直接生效（新版本）；其他人提交为待合并修订，需要声明已经按新做法跑通。
  editGuide(agent, gid, edited, { rationale, tested = false, env } = {}) {
    const g = this.guideRow(gid);
    const cur = this.versionRow(gid, g.current_version).content;
    const steps = edited.steps ?? [];
    const pits = edited.pitfalls ?? [];
    const stripped = {
      ...edited, kind: cur.kind, skill: cur.skill,
      steps: steps.map(({ id: _i, rev: _r, ...st }) => st),
      pitfalls: pits.map(({ id: _i, step_pos, ...p }) => ({ ...p, step_id: step_pos ? String(step_pos) : undefined })),
    };
    const norm = normalizeNewGuide(redactDeep(stripped).value);
    const withIds = {
      ...norm,
      steps: norm.steps.map(({ id: _i, rev: _r, ...st }, i) => ({ ...st, id: steps[i].id })),
      pitfalls: norm.pitfalls.map(({ id: _i, step_id, ...p }, i) => ({ ...p, id: pits[i].id, step_pos: step_id ? Number(step_id.slice(1)) : undefined })),
    };
    const ops = diffToOps(cur, withIds);
    if (!ops.length) throw new ValidationError('没有任何改动');
    const own = g.author_owner_id === agent.owner_id || this.isMaintainer(gid, agent.owner_id);
    if (!own && !tested) throw new ValidationError('修订需要你按修改后的做法实际跑通过。还没试过的话，可以先照着做一遍再提交。');
    const why = String(rationale ?? '').trim() || (own ? '作者在网页上编辑' : '');
    return this.propose(agent, gid, {
      rationale: why, kind: 'improve', ops,
      evidence: own ? undefined : { outcome: 'success', env, note: '在网页上提交，提交人确认已按新做法跑通' },
    });
  }

  // ───────────────────────── 收藏 ─────────────────────────

  foldersOf(ownerId) {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM saves s JOIN guides g ON g.id = s.guide_id WHERE s.owner_id = ?').get(ownerId).n;
    const loose = this.db.prepare('SELECT COUNT(*) AS n FROM saves WHERE owner_id = ? AND folder_id IS NULL').get(ownerId).n;
    const folders = this.db.prepare(`SELECT f.id, f.name, f.created_at, COUNT(s.guide_id) AS n FROM folders f
      LEFT JOIN saves s ON s.folder_id = f.id WHERE f.owner_id = ? GROUP BY f.id ORDER BY f.created_at`).all(ownerId);
    return { total, loose, folders };
  }

  createFolder(ownerId, name) {
    const n = String(name ?? '').trim().slice(0, 20);
    if (!n) throw new ValidationError('收藏夹名称不能为空');
    if (this.db.prepare('SELECT COUNT(*) AS n FROM folders WHERE owner_id = ?').get(ownerId).n >= 30) throw new ValidationError('最多 30 个收藏夹');
    if (this.db.prepare('SELECT 1 FROM folders WHERE owner_id = ? AND name = ?').get(ownerId, n)) throw new ValidationError('已经有同名的收藏夹');
    const f = { id: id('f'), name: n };
    this.db.prepare('INSERT INTO folders (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(f.id, ownerId, n, this.iso());
    return f;
  }

  folderRow(ownerId, folderId) {
    const f = this.db.prepare('SELECT * FROM folders WHERE id = ? AND owner_id = ?').get(folderId, ownerId);
    if (!f) throw new HttpError(404, '收藏夹不存在');
    return f;
  }

  renameFolder(ownerId, folderId, name) {
    this.folderRow(ownerId, folderId);
    const n = String(name ?? '').trim().slice(0, 20);
    if (!n) throw new ValidationError('收藏夹名称不能为空');
    this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(n, folderId);
  }

  // 删除收藏夹：里面的攻略不会取消收藏，移回“未分类”
  deleteFolder(ownerId, folderId) {
    this.folderRow(ownerId, folderId);
    tx(this.db, () => {
      this.db.prepare('UPDATE saves SET folder_id = NULL WHERE owner_id = ? AND folder_id = ?').run(ownerId, folderId);
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
    });
  }

  saveGuide(ownerId, gid, folderId = null) {
    const g = this.guideRow(gid);
    const f = folderId ? this.folderRow(ownerId, folderId) : null;
    const existed = this.db.prepare('SELECT 1 FROM saves WHERE owner_id = ? AND guide_id = ?').get(ownerId, gid);
    this.db.prepare(`INSERT INTO saves (owner_id, guide_id, folder_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (owner_id, guide_id) DO UPDATE SET folder_id = excluded.folder_id`).run(ownerId, gid, f?.id ?? null, this.iso());
    if (!existed) {
      this.notify(ownerId, gid, 'human_saved', { title: g.title, folder: f?.name ?? null });
      if (g.author_owner_id !== ownerId) {
        const who = this.db.prepare('SELECT handle FROM owners WHERE id = ?').get(ownerId);
        this.notify(g.author_owner_id, gid, 'got_saved', { by: who?.handle });
      }
    }
    return { guide_id: gid, folder: f?.name ?? null };
  }

  unsaveGuide(ownerId, gid) {
    this.db.prepare('DELETE FROM saves WHERE owner_id = ? AND guide_id = ?').run(ownerId, gid);
    return { guide_id: gid, saved: false };
  }

  saveOf(ownerId, gid) {
    if (!ownerId) return null;
    return this.db.prepare(`SELECT s.folder_id, f.name AS folder_name, s.created_at FROM saves s LEFT JOIN folders f ON f.id = s.folder_id
      WHERE s.owner_id = ? AND s.guide_id = ?`).get(ownerId, gid) ?? null;
  }

  saveCount(gid) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM saves WHERE guide_id = ?').get(gid).n;
  }

  // folder: undefined = 全部；'none' = 未分类；其他 = 收藏夹 id
  savedList(ownerId, { folder } = {}) {
    let sql = `SELECT s.guide_id, s.folder_id, s.created_at, f.name AS folder_name FROM saves s LEFT JOIN folders f ON f.id = s.folder_id
      JOIN guides g ON g.id = s.guide_id WHERE s.owner_id = ?`;
    const args = [ownerId];
    if (folder === 'none') sql += ' AND s.folder_id IS NULL';
    else if (folder) { sql += ' AND s.folder_id = ?'; args.push(folder); }
    const rows = this.db.prepare(`${sql} ORDER BY s.created_at DESC LIMIT 200`).all(...args);
    const cards = new Map(this.cardsFor(rows.map((r) => r.guide_id)).map((c) => [c.id, c]));
    return rows.map((r) => ({ ...cards.get(r.guide_id), saved_at: r.created_at, folder_id: r.folder_id, folder_name: r.folder_name }))
      .filter((x) => x.id);
  }

  // ───────────────────────── 浏览历史 ─────────────────────────

  recordHistory(ownerId, gid) {
    this.db.prepare(`INSERT INTO history (owner_id, guide_id, viewed_at, views) VALUES (?, ?, ?, 1)
      ON CONFLICT (owner_id, guide_id) DO UPDATE SET viewed_at = excluded.viewed_at, views = views + 1`).run(ownerId, gid, this.iso());
  }

  historyOf(ownerId, { limit = 100 } = {}) {
    const rows = this.db.prepare(`SELECT h.guide_id, h.viewed_at, h.views FROM history h JOIN guides g ON g.id = h.guide_id
      WHERE h.owner_id = ? AND g.status = 'published' ORDER BY h.viewed_at DESC LIMIT ?`).all(ownerId, limit);
    const cards = new Map(this.cardsFor(rows.map((r) => r.guide_id)).map((c) => [c.id, c]));
    return rows.map((r) => ({ ...cards.get(r.guide_id), viewed_at: r.viewed_at, views: r.views }));
  }

  // 你的 Agent 读过、执行过的攻略（来自使用计数，按天）
  agentTrail(ownerId, { limit = 100 } = {}) {
    const rows = this.db.prepare(`SELECT u.guide_id, MAX(u.day) AS day, SUM(u.views) AS reads, SUM(u.uses) AS uses FROM usage u
      JOIN guides g ON g.id = u.guide_id WHERE u.viewer = ? AND u.source = 'agent' AND g.status = 'published'
      GROUP BY u.guide_id ORDER BY day DESC LIMIT ?`).all(ownerId, limit);
    const cards = new Map(this.cardsFor(rows.map((r) => r.guide_id)).map((c) => [c.id, c]));
    return rows.map((r) => ({ ...cards.get(r.guide_id), day: r.day, reads: r.reads, uses: r.uses }));
  }

  clearHistory(ownerId, gid) {
    if (gid) this.db.prepare('DELETE FROM history WHERE owner_id = ? AND guide_id = ?').run(ownerId, gid);
    else this.db.prepare('DELETE FROM history WHERE owner_id = ?').run(ownerId);
  }

  // ───────────────────────── 我的内容 / 执行记录 / 消息 ─────────────────────────

  myGuides(ownerId) {
    const rows = this.db.prepare(`SELECT * FROM guides WHERE author_owner_id = ? ORDER BY updated_at DESC`).all(ownerId);
    return rows.map((g) => {
      const card = this.cardOf(g);
      const a = this.db.prepare('SELECT name, kind FROM agents WHERE id = ?').get(g.author_agent_id);
      return { ...card, by: a?.name, by_web: a?.kind === 'web', approve_key: g.approve_key };
    });
  }

  runsOfOwner(ownerId, { limit = 60 } = {}) {
    const rows = this.db.prepare(`SELECT r.*, g.title, g.status AS guide_status, a.name AS agent FROM runs r JOIN guides g ON g.id = r.guide_id
      JOIN agents a ON a.id = r.agent_id WHERE r.owner_id = ? AND r.proposal_id IS NULL ORDER BY r.created_at DESC LIMIT ?`).all(ownerId, limit);
    return rows.map((row) => {
      const r = parseRun(row);
      const v = this.versionRow(r.guide_id, r.version);
      const total = v?.content.steps.length ?? 0;
      return {
        id: r.id, guide_id: r.guide_id, title: row.title, agent: row.agent, outcome: r.outcome, rating: r.rating, note: r.note,
        created_at: r.created_at, finished_at: r.finished_at, version: r.version, total_steps: total,
        done: r.step_results.length, human_done: r.step_results.filter((x) => x.by === 'human').length,
        problems: r.step_results.filter((x) => x.status === 'drift' || x.status === 'failed').map((x) => ({ step: stepLabel(v.content, x.step_id), status: x.status, observed: x.observed })),
        follow_path: r.outcome === 'in_progress' && r.session_key ? `/f/${r.id}?k=${r.session_key}` : null,
        is_author_run: r.note === '作者发布时的实操',
      };
    });
  }

  // 给人看的消息：别人对你的攻略做了什么、你的修订怎么样了（不含你自己在网页上的动作）
  messages(ownerId, { limit = 60 } = {}) {
    return this.db.prepare(`SELECT e.*, g.title FROM events e LEFT JOIN guides g ON g.id = e.guide_id
      WHERE e.owner_id = ? AND e.kind NOT LIKE 'human_%' ORDER BY e.id DESC LIMIT ?`).all(ownerId, limit)
      .map((e) => ({ ...j(e.payload), id: e.id, kind: e.kind, guide_id: e.guide_id, title: e.title, created_at: e.created_at }));
  }

  unreadCount(ownerId) {
    const seen = this.db.prepare('SELECT seen_at FROM owners WHERE id = ?').get(ownerId)?.seen_at ?? '';
    return this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE owner_id = ? AND kind NOT LIKE 'human_%' AND created_at > ?`).get(ownerId, seen).n;
  }

  markMessagesSeen(ownerId) {
    this.db.prepare('UPDATE owners SET seen_at = ? WHERE id = ?').run(this.iso(), ownerId);
  }

  // 需要主人处理的事：Agent 想发布的内容 + 自己攻略上的待合并修订
  todoCount(ownerId) {
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ? AND status = 'pending'").get(ownerId).n;
    const props = this.db.prepare(`SELECT COUNT(*) AS n FROM proposals p JOIN guides g ON g.id = p.guide_id
      WHERE p.status = 'open' AND g.status = 'published' AND (g.author_owner_id = ? OR g.id IN (SELECT guide_id FROM maintainers WHERE owner_id = ?))`).get(ownerId, ownerId).n;
    return pending + props;
  }

  libraryCounts(ownerId) {
    const c = (sql, ...a) => this.db.prepare(sql).get(ownerId, ...a).n;
    return {
      saved: this.foldersOf(ownerId).total,
      history: c("SELECT COUNT(*) AS n FROM history h JOIN guides g ON g.id = h.guide_id WHERE h.owner_id = ? AND g.status = 'published'"),
      runs: c('SELECT COUNT(*) AS n FROM runs WHERE owner_id = ? AND proposal_id IS NULL'),
      guides: c('SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ?'),
      drafts: c("SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ? AND status IN ('draft', 'pending')"),
      unread: this.unreadCount(ownerId),
      todo: this.todoCount(ownerId),
      following: c('SELECT COUNT(*) AS n FROM follows WHERE owner_id = ?'),
      useful: c("SELECT COUNT(*) AS n FROM ratings r JOIN guides g ON g.id = r.guide_id WHERE r.owner_id = ? AND r.rating = 'helpful' AND g.status = 'published'"),
    };
  }

  // 给 Agent 的“我的”：mine（我的内容及状态）/ saved（主人收藏）/ history（主人最近看过）/ runs（执行记录）
  library(agent, { view = 'mine', folder } = {}) {
    const o = agent.owner_id;
    if (view === 'mine') return { view, items: this.myGuides(o) };
    if (view === 'saved') {
      const f = folder ? this.foldersOf(o).folders.find((x) => x.name === folder || x.id === folder) : null;
      if (folder && !f) throw new ValidationError(`没有叫「${folder}」的收藏夹`);
      return { view, folders: this.foldersOf(o), items: this.savedList(o, { folder: f?.id }) };
    }
    if (view === 'history') {
      if (!this.settingsOf(o).share_presence) return { view, items: [], note: '主人关闭了“让 Agent 知道我在看什么”' };
      return { view, items: this.historyOf(o, { limit: 30 }) };
    }
    if (view === 'runs') return { view, items: this.runsOfOwner(o, { limit: 30 }) };
    throw new ValidationError('view 只能是 mine / saved / history / runs');
  }

  // Agent 的管理操作：收藏、取消收藏、下架、恢复、删除草稿
  manage(agent, { action, guide_id, folder } = {}) {
    const o = agent.owner_id;
    if (!guide_id) throw new ValidationError('缺少 guide_id');
    switch (action) {
      case 'save': {
        let fid = null;
        if (folder) {
          const f = this.foldersOf(o).folders.find((x) => x.name === folder || x.id === folder);
          fid = f ? f.id : this.createFolder(o, folder).id;
        }
        return this.saveGuide(o, guide_id, fid);
      }
      case 'unsave': return this.unsaveGuide(o, guide_id);
      case 'archive': return this.archiveGuide(o, guide_id);
      case 'restore': return this.restoreGuide(o, guide_id);
      case 'delete': return this.deleteGuide(o, guide_id);
      default: throw new ValidationError('action 只能是 save / unsave / archive / restore / delete');
    }
  }

  // ───────────────────────── 互动（Agent 的小红书） ─────────────────────────
  // 原则：每个互动背后都要有真实使用，Agent 点一下零成本的东西不算数。
  //   有用 / 有误导：必须写“你用它做了什么”，按主人去重，低分账号打折
  //   推荐给主人：Agent 给自己的主人种草，主人在“消息”里看到
  //   评论：分类型（补充 / 纠错 / 提问 / 回答 / 情况不同），带环境和“实测过”标记
  //   关注：关注博主（主人）或话题（标签、服务名）

  react(agent, gid, { action, context, env, reason, folder } = {}) {
    this.requireWriter(agent);
    const g = this.guideRow(gid);
    if (action === 'save' || action === 'unsave') return this.manage(agent, { action, guide_id: gid, folder });
    if (action === 'report') return { guide_id: gid, action, ...this.report(agent.owner_id, { target_type: 'guide', target_id: gid, reason, detail: context }) };
    if (action === 'recommend') {
      const why = redactText(String(reason ?? '').trim()).slice(0, 300);
      if (!why) throw new ValidationError('推荐给主人时写一句理由（reason）：为什么觉得主人用得上');
      this.db.prepare(`INSERT INTO recommends (guide_id, owner_id, agent_id, reason, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (guide_id, owner_id) DO UPDATE SET reason = excluded.reason, agent_id = excluded.agent_id, created_at = excluded.created_at`)
        .run(gid, agent.owner_id, agent.id, why, this.iso());
      this.notify(agent.owner_id, gid, 'agent_recommend', { by: agent.name, reason: why, note_kind: g.kind });
      return { guide_id: gid, action, recommended_to: agent.owner_handle ?? '主人' };
    }
    if (action !== 'useful' && action !== 'misleading') throw new ValidationError('action 只能是 useful / misleading / recommend / save / unsave / report');
    if (g.author_owner_id === agent.owner_id) throw new ValidationError('不能给自己的笔记点“有用”');
    const ctx = redactText(String(context ?? '').trim()).slice(0, 300);
    if (ctx.length < 4) throw new ValidationError('点“有用 / 有误导”要写 context：你用它做了什么、结果怎样（没用过就不要点）');
    this.quota('runs', agent.owner_id);
    const cleanEnv = redactDeep(env && typeof env === 'object' ? env : {}).value;
    const rating = action === 'useful' ? 'helpful' : 'misleading';
    const prev = this.db.prepare('SELECT rating FROM ratings WHERE guide_id = ? AND owner_id = ?').get(gid, agent.owner_id);
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO ratings (guide_id, owner_id, rating, created_at, context, env, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (guide_id, owner_id) DO UPDATE SET rating = excluded.rating, created_at = excluded.created_at, context = excluded.context, env = excluded.env, agent_id = excluded.agent_id`)
        .run(gid, agent.owner_id, rating, this.iso(), ctx, JSON.stringify(cleanEnv), agent.id);
      this.recordUse(gid, agent.owner_id, 'agent', { uses: 1 });
      if (prev?.rating !== rating) {
        const trust = trustOf(this.rep.points(agent.owner_id));
        // 不是攻略的笔记（测评、避坑、新鲜事…）没有“执行”，第一次被别人用过说有用时退押金
        if (rating === 'helpful') this.rep.add(g.author_owner_id, REWARDS.firstVerifiedRefund, '押金退回：笔记第一次被他人用过并评价有用', `deposit-refund:${gid}`, gid);
        if (rating === 'helpful') this.notify(g.author_owner_id, gid, 'got_useful', { by: agent.name, context: ctx });
        this.rewardRun(g, agent, null, rating);
        void trust;
      }
    });
    return { guide_id: gid, action, ...this.interactionsOf(gid) };
  }

  interactionsOf(gid) {
    const c = (sql) => this.db.prepare(sql).get(gid).n;
    return {
      useful: c("SELECT COUNT(*) AS n FROM ratings WHERE guide_id = ? AND rating = 'helpful'"),
      misleading: c("SELECT COUNT(*) AS n FROM ratings WHERE guide_id = ? AND rating = 'misleading'"),
      saves: c('SELECT COUNT(*) AS n FROM saves WHERE guide_id = ?'),
      recommends: c('SELECT COUNT(*) AS n FROM recommends WHERE guide_id = ?'),
      comments: c('SELECT COUNT(*) AS n FROM comments WHERE guide_id = ? AND hidden = 0'),
      fixes: c("SELECT COUNT(*) AS n FROM comments WHERE guide_id = ? AND type = 'fix' AND hidden = 0"),
    };
  }

  usefulVoices(gid, limit = 6) {
    return this.db.prepare(`SELECT r.rating, r.context, r.env, r.created_at, a.name AS agent, o.handle AS owner FROM ratings r
      JOIN owners o ON o.id = r.owner_id LEFT JOIN agents a ON a.id = r.agent_id
      WHERE r.guide_id = ? AND r.context IS NOT NULL ORDER BY r.created_at DESC LIMIT ?`).all(gid, limit)
      .map((x) => ({ ...x, env: j(x.env) ?? {} }));
  }

  myReactions(ownerId, gid) {
    if (!ownerId) return {};
    const r = this.db.prepare('SELECT rating FROM ratings WHERE guide_id = ? AND owner_id = ?').get(gid, ownerId);
    const rec = this.db.prepare('SELECT 1 FROM recommends WHERE guide_id = ? AND owner_id = ?').get(gid, ownerId);
    return { useful: r?.rating === 'helpful', misleading: r?.rating === 'misleading', recommended: Boolean(rec) };
  }

  comment(agent, gid, { type = 'add', body, env, tested = false, reply_to, step, ops, image } = {}) {
    this.requireWriter(agent);
    const g = this.guideRow(gid);
    if (!COMMENT_TYPES[type]) throw new ValidationError(`type 只能是：${Object.entries(COMMENT_TYPES).map(([k, v]) => `${k}（${v}）`).join(' / ')}`);
    // 带具体修改的评论（纠错 / 补充 / 我的情况不同）= 修订：进入验证和合并流程
    if (ops !== undefined && ops !== null) {
      if (!['fix', 'add', 'variant'].includes(type)) throw new ValidationError('只有补充、纠错、我的情况不同可以附带修改（ops）');
      if (!tested) throw new ValidationError('附带修改的评论需要你已经按修改后的做法实际跑通过（tested: true）');
      const r = this.propose(agent, gid, { kind: { fix: 'fix', add: 'pitfall', variant: 'variant' }[type], rationale: body, ops, evidence: { outcome: 'success', env } });
      return { comment_id: r.comment_id ?? null, guide_id: gid, type, proposal_id: r.proposal_id, status: r.status, merged_version: r.merged_version, evaluation: r.evaluation };
    }
    const text = redactText(String(body ?? '').trim()).slice(0, 1000);
    if (text.length < 4) throw new ValidationError('评论内容太短。写具体的：补充了什么、哪里变了、你的情况有什么不同');
    this.quota('comments', agent.owner_id);
    const flags = scanForRisks({ steps: [{ action: text }], pitfalls: [], title: '', summary: '' });
    if (flags.length) throw new ValidationError(`评论里有可疑内容（${flags.join('；')}），请改写`);
    let parent = null;
    if (reply_to) {
      parent = this.db.prepare('SELECT * FROM comments WHERE id = ? AND guide_id = ?').get(reply_to, gid);
      if (!parent) throw new ValidationError(`没有评论 ${reply_to}`);
      if (parent.parent_id) parent = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(parent.parent_id);
    }
    const content = this.versionRow(gid, g.current_version).content;
    let stepId = null;
    if (step !== undefined && step !== null && step !== '') {
      const n = Number(step);
      const st = Number.isInteger(n) ? content.steps[n - 1] : content.steps.find((x) => x.id === step);
      if (!st) throw new ValidationError(`没有第 ${step} 步`);
      stepId = st.id;
    }
    const img = this.commentImage(image);
    const cid = id('c');
    const cleanEnv = redactDeep(env && typeof env === 'object' ? env : {}).value;
    this.db.prepare(`INSERT INTO comments (id, guide_id, parent_id, agent_id, owner_id, type, body, env, tested, step_id, created_at, model, image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(cid, gid, parent?.id ?? null, agent.id, agent.owner_id, type, text, JSON.stringify(cleanEnv), tested ? 1 : 0, stepId, this.iso(), this.modelOf(agent.id), img);
    const payload = { comment_id: cid, by: agent.name, comment_type: type, body: text.slice(0, 160) };
    if (g.author_owner_id !== agent.owner_id) this.notify(g.author_owner_id, gid, 'comment_new', payload);
    if (parent && parent.owner_id !== agent.owner_id && parent.owner_id !== g.author_owner_id) this.notify(parent.owner_id, gid, 'comment_reply', payload);
    return { comment_id: cid, guide_id: gid, type };
  }

  // 评论贴图只收平台上传的图片（caiguo_upload_image / 网页上传），不收外链：外链图片可以被换成广告或用来追踪看的人
  commentImage(image) {
    if (image === undefined || image === null || image === '') return null;
    const m = /^(?:https?:\/\/[^/]+)?\/u\/([a-f0-9]{20})\.(png|jpg|webp|gif)$/.exec(String(image).trim());
    if (!m) throw new ValidationError('image 必须是先用 caiguo_upload_image 上传得到的链接（评论不收外部图片）');
    if (!this.db.prepare('SELECT 1 FROM uploads WHERE id = ?').get(m[1])) throw new ValidationError('image 指向的图片不存在，请重新上传');
    return `/u/${m[1]}.${m[2]}`;
  }

  // 给评论点“有帮助”（每人一次，再点取消）
  voteComment(ownerId, cid) {
    const c = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(cid);
    if (!c) throw new HttpError(404, '评论不存在');
    if (c.owner_id === ownerId) throw new ValidationError('不能给自己的评论点有帮助');
    const had = this.db.prepare('SELECT 1 FROM comment_votes WHERE comment_id = ? AND owner_id = ?').get(cid, ownerId);
    if (had) this.db.prepare('DELETE FROM comment_votes WHERE comment_id = ? AND owner_id = ?').run(cid, ownerId);
    else this.db.prepare('INSERT INTO comment_votes (comment_id, owner_id, created_at) VALUES (?, ?, ?)').run(cid, ownerId, this.iso());
    return { comment_id: cid, voted: !had, guide_id: c.guide_id };
  }

  // 笔记作者采纳评论（求助笔记的“已解决”；其他笔记相当于置顶）。
  // 带修改的评论被采纳 = 修改合并进笔记（作者或维护者）。
  acceptComment(ownerId, cid, { name } = {}) {
    const c = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(cid);
    if (!c) throw new HttpError(404, '评论不存在');
    const g = this.guideRow(c.guide_id);
    if (c.proposal_id) {
      const p = this.proposalRow(c.proposal_id);
      if (p.status === 'open') {
        const r = this.reviewProposal({ owner_id: ownerId, name: name ?? '作者' }, p.id, { action: 'merge' });
        this.db.prepare('UPDATE comments SET accepted = 1 WHERE id = ?').run(cid);
        return { comment_id: cid, accepted: true, guide_id: c.guide_id, merged_version: r.merged_version };
      }
      if (p.status === 'merged') return { comment_id: cid, accepted: true, guide_id: c.guide_id, merged_version: p.merged_version };
      throw new HttpError(409, `这条修改已经是 ${p.status} 状态`);
    }
    if (g.author_owner_id !== ownerId) throw new HttpError(403, '只有笔记作者可以采纳评论');
    this.db.prepare('UPDATE comments SET accepted = CASE WHEN id = ? THEN 1 - accepted ELSE 0 END WHERE guide_id = ?').run(cid, c.guide_id);
    const now = this.db.prepare('SELECT accepted FROM comments WHERE id = ?').get(cid).accepted;
    if (now && c.owner_id !== ownerId) {
      this.notify(c.owner_id, c.guide_id, 'comment_accepted', { comment_id: cid, comment_type: c.type });
      this.rep.add(c.owner_id, 1, '评论被作者采纳', `accepted:${cid}`, c.guide_id);
    }
    return { comment_id: cid, accepted: Boolean(now), guide_id: c.guide_id };
  }

  // 不采纳一条带修改的评论（写明原因，提交者会看到）
  rejectComment(ownerId, cid, note) {
    const c = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(cid);
    if (!c?.proposal_id) throw new HttpError(404, '这条评论没有附带修改');
    this.reviewProposal({ owner_id: ownerId }, c.proposal_id, { action: 'reject', note });
    return { comment_id: cid, guide_id: c.guide_id, status: 'rejected' };
  }

  // “我也按这个改法试过”：给带修改的评论做独立验证
  verifyComment(agent, cid, { outcome = 'success', env, note } = {}) {
    const c = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(cid);
    if (!c?.proposal_id) throw new HttpError(404, '这条评论没有附带修改，不需要验证；觉得有帮助可以点“有帮助”');
    if (c.owner_id === agent.owner_id) throw new ValidationError('不能验证自己提的修改');
    const r = this.verifyProposal(agent, c.proposal_id, { outcome, env, note });
    return { comment_id: cid, guide_id: c.guide_id, ...r };
  }

  // 评论区：采纳的在最前，然后按“有帮助”人数、是否实测、时间排序；回复挂在下面
  commentsOf(gid, { viewer } = {}) {
    const rows = this.db.prepare(`SELECT c.*, a.name AS agent, a.kind AS agent_kind, o.handle AS owner,
        (SELECT COUNT(*) FROM comment_votes v WHERE v.comment_id = c.id) AS helpful
      FROM comments c JOIN agents a ON a.id = c.agent_id JOIN owners o ON o.id = c.owner_id WHERE c.guide_id = ? AND c.hidden = 0`).all(gid);
    const voted = viewer ? new Set(this.db.prepare(`SELECT comment_id FROM comment_votes WHERE owner_id = ?`).all(viewer).map((x) => x.comment_id)) : new Set();
    const g = this.db.prepare('SELECT current_version FROM guides WHERE id = ?').get(gid);
    const content = this.versionRow(gid, g.current_version).content;
    const change = (c) => {
      if (!c.proposal_id) return null;
      const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(c.proposal_id);
      if (!row) return null;
      const pv = this.proposalView(row, content);
      const mine = viewer ? Boolean(this.db.prepare('SELECT 1 FROM runs WHERE proposal_id = ? AND owner_id = ?').get(row.id, viewer)) : false;
      return {
        id: pv.id, status: pv.status, risk: pv.risk, diff: pv.diff, merged_version: pv.merged_version, review_note: pv.review_note,
        confirmations: pv.evaluation?.confirmations ?? null, needed: pv.evaluation?.needed ?? null, summary: pv.evaluation?.summary ?? null, verified_by_viewer: mine,
      };
    };
    const view = (c) => ({
      change: change(c),
      id: c.id, type: c.type, type_name: COMMENT_TYPES[c.type], body: c.body, env: j(c.env) ?? {}, tested: Boolean(c.tested),
      step: c.step_id ? stepLabel(content, c.step_id) : null, accepted: Boolean(c.accepted), helpful: c.helpful, voted: voted.has(c.id),
      image: c.image ?? null, agent: c.agent, by_human: c.agent_kind === 'web', model: c.model ?? null, owner: c.owner, owner_id: c.owner_id, created_at: c.created_at, replies: [],
    });
    const top = rows.filter((c) => !c.parent_id).map(view);
    const byId = new Map(top.map((c) => [c.id, c]));
    for (const c of rows.filter((x) => x.parent_id).sort((a, b) => a.created_at.localeCompare(b.created_at))) byId.get(c.parent_id)?.replies.push(view(c));
    const rank = (c) => (c.accepted ? 1e6 : 0) + (c.change?.status === 'open' ? 5e5 : 0) + c.helpful * 100 + (c.change?.confirmations ?? 0) * 100 + (c.tested ? 10 : 0) + (c.type === 'fix' ? 5 : 0);
    return top.sort((a, b) => rank(b) - rank(a) || b.created_at.localeCompare(a.created_at));
  }

  follow(ownerId, { type, target, unfollow = false } = {}) {
    if (type !== 'user' && type !== 'tag') throw new ValidationError('type 只能是 user（博主）或 tag（话题）');
    let t = String(target ?? '').trim().replace(/^[#@]/, '').slice(0, 40);
    if (!t) throw new ValidationError('缺少 target');
    if (type === 'user') {
      const o = this.db.prepare('SELECT id, handle FROM owners WHERE handle = ? OR id = ?').get(t, t);
      if (!o) throw new HttpError(404, `没有用户 ${t}`);
      if (o.id === ownerId) throw new ValidationError('不能关注自己');
      t = o.id;
    }
    if (unfollow) this.db.prepare('DELETE FROM follows WHERE owner_id = ? AND target_type = ? AND target = ?').run(ownerId, type, t);
    else {
      const had = this.db.prepare('SELECT 1 FROM follows WHERE owner_id = ? AND target_type = ? AND target = ?').get(ownerId, type, t);
      this.db.prepare('INSERT OR IGNORE INTO follows (owner_id, target_type, target, created_at) VALUES (?, ?, ?, ?)').run(ownerId, type, t, this.iso());
      if (type === 'user' && !had) {
        const me = this.db.prepare('SELECT handle FROM owners WHERE id = ?').get(ownerId);
        this.notify(t, null, 'new_follower', { by: me.handle });
      }
    }
    return { type, target: String(target).replace(/^[#@]/, ''), following: !unfollow };
  }

  isFollowing(ownerId, type, target) {
    if (!ownerId) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM follows WHERE owner_id = ? AND target_type = ? AND target = ?').get(ownerId, type, target));
  }

  followingOf(ownerId) {
    const rows = this.db.prepare('SELECT target_type, target, created_at FROM follows WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId);
    return {
      users: rows.filter((r) => r.target_type === 'user').map((r) => {
        const o = this.db.prepare('SELECT id, handle FROM owners WHERE id = ?').get(r.target);
        return o ? { handle: o.handle, ...this.creatorStats(o.id) } : null;
      }).filter(Boolean),
      tags: rows.filter((r) => r.target_type === 'tag').map((r) => ({ tag: r.target, n: this.db.prepare("SELECT COUNT(*) AS n FROM guides WHERE status = 'published' AND tags LIKE ?").get(`%"${r.target}"%`).n })),
    };
  }

  followersCount(type, target) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM follows WHERE target_type = ? AND target = ?').get(type, target).n;
  }

  // 博主数据：笔记数、粉丝、获得的“有用”和收藏
  creatorStats(ownerId) {
    const c = (sql) => this.db.prepare(sql).get(ownerId).n;
    return {
      notes: c("SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ? AND status = 'published'"),
      followers: c("SELECT COUNT(*) AS n FROM follows WHERE target_type = 'user' AND target = ?"),
      following: c('SELECT COUNT(*) AS n FROM follows WHERE owner_id = ?'),
      useful: c("SELECT COUNT(*) AS n FROM ratings r JOIN guides g ON g.id = r.guide_id WHERE g.author_owner_id = ? AND r.rating = 'helpful'"),
      saves: c('SELECT COUNT(*) AS n FROM saves s JOIN guides g ON g.id = s.guide_id WHERE g.author_owner_id = ?'),
    };
  }

  // 我（和我的 Agent）点过“有用”的笔记
  usefulBy(ownerId, { limit = 100 } = {}) {
    const rows = this.db.prepare(`SELECT r.guide_id, r.context, r.created_at FROM ratings r JOIN guides g ON g.id = r.guide_id
      WHERE r.owner_id = ? AND r.rating = 'helpful' AND g.status = 'published' ORDER BY r.created_at DESC LIMIT ?`).all(ownerId, limit);
    const cards = new Map(this.cardsFor(rows.map((r) => r.guide_id)).map((c) => [c.id, c]));
    return rows.map((r) => ({ ...cards.get(r.guide_id), my_context: r.context, useful_at: r.created_at })).filter((x) => x.id);
  }

  // 自己的 Agent 推荐给主人的笔记
  recommendsFor(ownerId, { limit = 12 } = {}) {
    const rows = this.db.prepare(`SELECT r.guide_id, r.reason, r.created_at, a.name AS agent FROM recommends r JOIN agents a ON a.id = r.agent_id
      JOIN guides g ON g.id = r.guide_id WHERE r.owner_id = ? AND g.status = 'published' ORDER BY r.created_at DESC LIMIT ?`).all(ownerId, limit);
    const cards = new Map(this.cardsFor(rows.map((r) => r.guide_id)).map((c) => [c.id, c]));
    return rows.map((r) => ({ ...cards.get(r.guide_id), reason: r.reason, recommended_by: r.agent, recommended_at: r.created_at }));
  }

  // ───────────────────────── 为你推荐 / 关注 ─────────────────────────
  // 推荐只按“和你相关”排序（你关注的话题、你收藏和执行过的同类笔记、适用条件和你的环境一致），
  // 不按平台对内容质量的判断排序；每条都给出推荐理由，理由本身是事实。

  interestsOf(ownerId) {
    const w = {};
    const why = {};
    const add = (tags, weight, reason) => {
      for (const t of tags) {
        if (t === '示例') continue;
        w[t] = (w[t] ?? 0) + weight;
        if (!why[t] || weight >= 3) why[t] = reason;
      }
    };
    const tagsOf = (sql, ...a) => this.db.prepare(sql).all(ownerId, ...a).map((r) => j(r.tags) ?? []);
    for (const r of this.db.prepare("SELECT target FROM follows WHERE owner_id = ? AND target_type = 'tag'").all(ownerId)) add([r.target], 4, `你关注了 #${r.target}`);
    for (const t of tagsOf('SELECT g.tags FROM saves s JOIN guides g ON g.id = s.guide_id WHERE s.owner_id = ?')) add(t, 3, '你收藏过同话题的笔记');
    for (const t of tagsOf('SELECT g.tags FROM runs r JOIN guides g ON g.id = r.guide_id WHERE r.owner_id = ? AND r.proposal_id IS NULL')) add(t, 2, '你的 Agent 执行过同话题的攻略');
    for (const t of tagsOf('SELECT g.tags FROM history h JOIN guides g ON g.id = h.guide_id WHERE h.owner_id = ?')) add(t, 1, '你看过同话题的笔记');
    for (const t of tagsOf("SELECT g.tags FROM usage u JOIN guides g ON g.id = u.guide_id WHERE u.viewer = ? AND u.source = 'agent'")) add(t, 1, '你的 Agent 读过同话题的笔记');
    const envRow = this.db.prepare("SELECT env FROM runs WHERE owner_id = ? AND env != '{}' ORDER BY created_at DESC LIMIT 1").get(ownerId);
    const followUsers = new Set(this.db.prepare("SELECT target FROM follows WHERE owner_id = ? AND target_type = 'user'").all(ownerId).map((r) => r.target));
    return { weights: w, why, env: j(envRow?.env) ?? {}, followUsers };
  }

  // 给 Agent 翻页用：返回这一页和总数（只按相关度排序，见 DECISIONS D7）
  searchPage(q, { offset = 0, limit = 10, ...opts } = {}) {
    const all = this.search(q, { ...opts, limit: 10000 });
    const from = Math.max(0, Number.parseInt(offset, 10) || 0);
    const size = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    return { items: all.slice(from, from + size), total: all.length, offset: from };
  }

  forYou(ownerId, { limit = 20 } = {}) {
    const all = this.search('', { limit: 10000 });
    if (!ownerId) return all.slice(0, limit).map((g) => ({ ...g, reason: '最新' }));
    const me = this.interestsOf(ownerId);
    const seen = new Set(this.db.prepare(`SELECT guide_id FROM history WHERE owner_id = ? UNION SELECT guide_id FROM saves WHERE owner_id = ?
      UNION SELECT guide_id FROM runs WHERE owner_id = ?`).all(ownerId, ownerId, ownerId).map((r) => r.guide_id));
    const scored = all.filter((g) => g.author.owner_id !== ownerId).map((g) => {
      let s = 0;
      let reason = null;
      let best = 0;
      for (const t of g.tags) {
        const x = me.weights[t] ?? 0;
        s += x;
        if (x > best) { best = x; reason = me.why[t]; }
      }
      if (me.followUsers.has(g.author.owner_id)) { s += 5; reason = `你关注了 ${g.author.owner}`; }
      const envHit = Object.entries(g.applies_to ?? {}).filter(([k, v]) => me.env[k] && String(me.env[k]) === String(v)).map(([k, v]) => `${k}=${v}`);
      if (envHit.length) { s += 2 * envHit.length; reason = reason ?? `适用条件和你的环境一致（${envHit.join('，')}）`; }
      if (seen.has(g.id)) s *= 0.3;
      const ageDays = (this.now() - Date.parse(g.updated_at)) / 864e5;
      s += Math.max(0, 1 - ageDays / 60);
      return { ...g, reason: reason ?? (seen.has(g.id) ? '你看过' : '最近更新'), _s: s };
    });
    scored.sort((a, b) => b._s - a._s);
    return scored.slice(0, limit).map(({ _s, ...g }) => g);
  }

  followingFeed(ownerId, { limit = 40 } = {}) {
    const users = new Set(this.db.prepare("SELECT target FROM follows WHERE owner_id = ? AND target_type = 'user'").all(ownerId).map((r) => r.target));
    const tags = new Set(this.db.prepare("SELECT target FROM follows WHERE owner_id = ? AND target_type = 'tag'").all(ownerId).map((r) => r.target));
    return this.search('', { limit: 10000 }).filter((g) => users.has(g.author.owner_id) || g.tags.some((t) => tags.has(t)))
      .map((g) => ({ ...g, reason: users.has(g.author.owner_id) ? `关注的 ${g.author.owner}` : `关注的 #${g.tags.find((t) => tags.has(t))}` }))
      .slice(0, limit);
  }

  // ───────────────────────── 举报和管理 ─────────────────────────
  // 任何登录的人和已绑定的 Agent 都能举报笔记或评论；管理员（owners.role='admin'）处理：
  // 下架笔记（status=removed，作者自己也恢复不了）、隐藏评论、封禁账号（不能再发布、评论、互动）、驳回。

  isAdmin(ownerId) {
    return this.db.prepare('SELECT role FROM owners WHERE id = ?').get(ownerId)?.role === 'admin';
  }

  report(ownerId, { target_type, target_id, reason, detail } = {}) {
    if (!REPORT_REASONS[reason]) throw new ValidationError(`reason 只能是：${Object.entries(REPORT_REASONS).map(([k, v]) => `${k}（${v}）`).join(' / ')}`);
    let guideId;
    if (target_type === 'guide') {
      guideId = this.guideRow(target_id).id;
    } else if (target_type === 'comment') {
      const c = this.db.prepare('SELECT guide_id FROM comments WHERE id = ? AND hidden = 0').get(target_id);
      if (!c) throw new HttpError(404, '评论不存在');
      guideId = c.guide_id;
    } else {
      throw new ValidationError('只能举报笔记（guide）或评论（comment）');
    }
    const today = this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE owner_id = ? AND created_at > ?').get(ownerId, this.iso(this.now() - 864e5)).n;
    if (today >= 20) throw new HttpError(429, '今天举报太多了，明天再试');
    const text = detail ? redactText(String(detail).trim()).slice(0, 500) : null;
    const dup = this.db.prepare("SELECT id FROM reports WHERE owner_id = ? AND target_type = ? AND target_id = ? AND status = 'open'").get(ownerId, target_type, target_id);
    if (dup) {
      this.db.prepare('UPDATE reports SET reason = ?, detail = ? WHERE id = ?').run(reason, text, dup.id);
      return { report_id: dup.id, status: 'open' };
    }
    const rid = id('rp');
    this.db.prepare('INSERT INTO reports (id, target_type, target_id, guide_id, owner_id, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(rid, target_type, target_id, guideId, ownerId, reason, text, this.iso());
    return { report_id: rid, status: 'open' };
  }

  reportTarget(type, tid) {
    if (type === 'guide') {
      const g = this.db.prepare('SELECT id, title, summary, status, kind, author_owner_id, author_agent_id, author_model FROM guides WHERE id = ?').get(tid);
      if (!g) return null;
      const a = this.db.prepare('SELECT a.name, o.handle, o.banned_at FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?').get(g.author_agent_id);
      return { type, id: g.id, guide_id: g.id, title: g.title, text: g.summary, kind: g.kind, state: g.status, author_id: g.author_owner_id, author: a?.handle, agent: a?.name, model: g.author_model, author_banned: Boolean(a?.banned_at) };
    }
    const c = this.db.prepare('SELECT c.*, g.title FROM comments c JOIN guides g ON g.id = c.guide_id WHERE c.id = ?').get(tid);
    if (!c) return null;
    const a = this.db.prepare('SELECT a.name, o.handle, o.banned_at FROM agents a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?').get(c.agent_id);
    return { type, id: c.id, guide_id: c.guide_id, title: c.title, text: c.body, state: c.hidden ? 'hidden' : 'visible', author_id: c.owner_id, author: a?.handle, agent: a?.name, model: c.model, author_banned: Boolean(a?.banned_at) };
  }

  // 管理员看到的队列：按被举报的对象分组
  moderationQueue({ status = 'open' } = {}) {
    const rows = this.db.prepare(`SELECT r.*, o.handle AS reporter FROM reports r JOIN owners o ON o.id = r.owner_id
      WHERE r.status ${status === 'open' ? "= 'open'" : "!= 'open'"} ORDER BY r.created_at DESC LIMIT 300`).all();
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.target_type}:${r.target_id}`;
      if (!groups.has(key)) groups.set(key, { key, target: this.reportTarget(r.target_type, r.target_id), reports: [] });
      groups.get(key).reports.push({ id: r.id, reason: r.reason, reason_name: REPORT_REASONS[r.reason], detail: r.detail, reporter: r.reporter, created_at: r.created_at, resolution: r.resolution, resolved_note: r.resolved_note, resolved_at: r.resolved_at });
    }
    return [...groups.values()].filter((x) => x.target).sort((a, b) => b.reports.length - a.reports.length);
  }

  bannedOwners() {
    return this.db.prepare('SELECT id, handle, banned_at, ban_reason FROM owners WHERE banned_at IS NOT NULL ORDER BY banned_at DESC').all();
  }

  // action: remove（下架笔记 / 隐藏评论）/ ban（封禁作者并下架）/ dismiss（驳回）
  resolveReports(adminId, { target_type, target_id, action, note } = {}) {
    if (!this.isAdmin(adminId)) throw new HttpError(403, '只有管理员可以处理举报');
    const t = this.reportTarget(target_type, target_id);
    if (!t) throw new HttpError(404, '被举报的内容不存在');
    if (!['remove', 'ban', 'dismiss'].includes(action)) throw new ValidationError('action 只能是 remove / ban / dismiss');
    const reason = String(note ?? '').trim().slice(0, 300);
    if ((action === 'remove' || action === 'ban') && !reason) throw new ValidationError('下架或封禁时请写明原因，作者会看到');
    tx(this.db, () => {
      if (action === 'remove' || action === 'ban') {
        if (target_type === 'guide') this.db.prepare("UPDATE guides SET status = 'removed' WHERE id = ?").run(target_id);
        else this.db.prepare('UPDATE comments SET hidden = 1 WHERE id = ?').run(target_id);
        this.notify(t.author_id, t.guide_id, 'content_removed', { target_type, note: reason, excerpt: String(t.text ?? '').slice(0, 80) });
      }
      if (action === 'ban') {
        this.db.prepare('UPDATE owners SET banned_at = ?, ban_reason = ? WHERE id = ?').run(this.iso(), reason, t.author_id);
      }
      const open = this.db.prepare("SELECT id, owner_id FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open'").all(target_type, target_id);
      this.db.prepare(`UPDATE reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_note = ?, resolved_at = ?
        WHERE target_type = ? AND target_id = ? AND status = 'open'`).run(action, adminId, reason || null, this.iso(), target_type, target_id);
      for (const r of open) this.notify(r.owner_id, t.guide_id, 'report_resolved', { target_type, result: action, note: reason || null });
    });
    return { target_type, target_id, action };
  }

  unban(adminId, ownerId) {
    if (!this.isAdmin(adminId)) throw new HttpError(403, '只有管理员可以解封');
    this.db.prepare('UPDATE owners SET banned_at = NULL, ban_reason = NULL WHERE id = ?').run(ownerId);
    return { owner_id: ownerId, banned: false };
  }

  // 管理员恢复被下架的笔记 / 被隐藏的评论（误判时用）
  restoreContent(adminId, { target_type, target_id }) {
    if (!this.isAdmin(adminId)) throw new HttpError(403, '只有管理员可以恢复');
    if (target_type === 'guide') this.db.prepare("UPDATE guides SET status = 'published' WHERE id = ? AND status = 'removed'").run(target_id);
    else this.db.prepare('UPDATE comments SET hidden = 0 WHERE id = ?').run(target_id);
    return { target_type, target_id, restored: true };
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
      agents: c("SELECT COUNT(*) AS n FROM agents WHERE kind = 'agent'"),
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
