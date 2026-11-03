// HTTP 层。三类入口分开：
//   给人看的网页（/、/g/<id>、/activity、/me、/f/<run>、/approve/<id>…）
//   给 Agent 读的纯文本（/llms.txt、/g/<id>.md、/search.md、/feed.md）
//   给程序/插件的接口（/api/*、远程 MCP /mcp）
// 只用 node:http，零依赖。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HttpError } from './service.js';
import { createMcpHandler } from '../plugin/mcp/protocol.js';
import { TOOLS, INSTRUCTIONS, callTool, formatGuide, formatSearch, formatFeed } from '../plugin/mcp/tools.js';
import * as V from './web/views.js';
import { llmsTxt } from './agent-text.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, 'web', 'style.css'), 'utf8');
const MAX_BODY = 256 * 1024;
const COOKIE = 'cg_s';

export function createApp(svc, { publicUrl } = {}) {
  const registerHits = new Map();
  const secure = Boolean(publicUrl && publicUrl.startsWith('https://'));

  const page = (req, res, render, status = 200) => html(res, render(meInfo(req)), status);

  const routes = [
    // ───────────── 给人看的网页 ─────────────
    ['GET', /^\/$/, (req, res, m, url) => page(req, res, (me) => V.renderFeed({
      guides: svc.search(url.searchParams.get('q') ?? '', { tag: url.searchParams.get('tag') || undefined, kind: url.searchParams.get('kind') || undefined, limit: 60, sort: url.searchParams.get('sort') || undefined }),
      q: url.searchParams.get('q') ?? '', tag: url.searchParams.get('tag') ?? '', sort: url.searchParams.get('sort') ?? '', kind: url.searchParams.get('kind') ?? '',
      tags: svc.tags(), stats: svc.stats(), me,
    }))],
    ['GET', /^\/g\/([\w-]+)\.md$/, (req, res, m) => markdown(res, guideMarkdown(req, m[1]))],
    ['GET', /^\/g\/([\w-]+)$/, (req, res, m, url) => {
      if (url.searchParams.get('format') === 'agent' || wantsMarkdown(req)) return markdown(res, guideMarkdown(req, m[1]));
      const me = meInfo(req);
      const g = svc.getGuide(m[1], { viewer: me ? me.owner_id : anonViewer(req, 'web'), source: 'web', presenceOwner: me?.owner_id });
      return html(res, V.renderGuide(g, { me, sent: url.searchParams.has('sent') }));
    }],
    ['POST', /^\/g\/([\w-]+)\/send$/, async (req, res, m) => {
      const me = requireMe(req, await form(req));
      svc.sendToAgent(me.owner_id, m[1], null);
      redirect(res, `/g/${m[1]}?sent=1`);
    }],
    ['GET', /^\/activity$/, (req, res, m, url) => page(req, res, (me) => {
      const all = svc.search('', { limit: 100 });
      return V.renderActivity({
        items: svc.activity({ type: url.searchParams.get('type') || undefined }), type: url.searchParams.get('type') ?? '',
        trending: all.filter((g) => g.suspect_steps || g.open_proposals).slice(0, 3), contributors: svc.topContributors(5), me,
      });
    })],
    ['GET', /^\/o\/([^/]+)$/, (req, res, m, url) => page(req, res, (me) => V.renderProfile(svc.profile(decodeURIComponent(m[1])), { tab: url.searchParams.get('tab'), me }))],
    ['GET', /^\/connect$/, (req, res) => page(req, res, (me) => V.renderConnect({ base: baseUrl(req), me }))],

    // 主人：登录、控制台
    ['GET', /^\/login\/([a-f0-9]{40})$/, (req, res, m) => {
      const { session } = svc.consumeLogin(m[1]);
      res.writeHead(303, { location: '/me', 'set-cookie': `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}` });
      res.end();
    }],
    ['POST', /^\/logout$/, async (req, res) => {
      requireMe(req, await form(req));
      svc.logout(cookie(req, COOKIE));
      res.writeHead(303, { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
      res.end();
    }],
    ['GET', /^\/me$/, (req, res) => {
      const me = meInfo(req);
      if (!me) return html(res, V.renderLoginNeeded({ me: null }));
      return html(res, V.renderConsole(svc.consoleData(me.owner_id), { me }));
    }],
    ['POST', /^\/me\/settings$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.updateSettings(me.owner_id, { require_publish_approval: f.require_publish_approval === 'on', share_presence: f.share_presence === 'on' });
      redirect(res, '/me#settings');
    }],
    ['POST', /^\/me\/agents\/([\w-]+)\/revoke$/, async (req, res, m) => {
      const me = requireMe(req, await form(req));
      svc.revokeAgent(me.owner_id, m[1]);
      redirect(res, '/me#agents');
    }],
    ['POST', /^\/me\/publish\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.reviewPublish(m[1], { ownerId: me.owner_id, action: f.action });
      redirect(res, f.action === 'approve' ? `/g/${m[1]}` : '/me');
    }],
    ['POST', /^\/me\/proposals\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.reviewProposal({ owner_id: me.owner_id, name: `${me.handle}（网页）` }, m[1], { action: f.action, note: f.note });
      redirect(res, '/me#review');
    }],

    // 发布确认链接（Agent 发给主人）
    ['GET', /^\/approve\/([\w-]+)$/, (req, res, m, url) => page(req, res, (me) => V.renderApprove(svc.pendingPreview(m[1], { key: url.searchParams.get('k'), ownerId: me?.owner_id }), { me }))],
    ['POST', /^\/approve\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      const r = svc.reviewPublish(m[1], { key: f.k, action: f.action });
      if (r.status === 'published') return redirect(res, `/g/${m[1]}`);
      return page(req, res, (me) => V.renderMessage({ title: '已取消发布', text: '这篇攻略不会公开。', me }));
    }],

    // 跟做页（本人步骤）
    ['GET', /^\/f\/([\w-]+)$/, (req, res, m, url) => page(req, res, (me) => V.renderFollow(svc.followView(m[1], url.searchParams.get('k')), { key: url.searchParams.get('k'), me }))],
    ['POST', /^\/f\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      svc.humanDone(m[1], f.k, f.step_id, { problem: f.action === 'problem' ? (f.problem || '用户在跟做页报告遇到问题') : null });
      redirect(res, `/f/${m[1]}?k=${encodeURIComponent(f.k)}`);
    }],

    ['GET', /^\/u\/([a-f0-9]{20})\.(png|jpg|webp|gif)$/, (req, res, m) => {
      const up = svc.getUpload(m[1]);
      send(res, 200, up.data, up.mime, { 'cache-control': 'public, max-age=31536000, immutable' });
    }],
    ['GET', /^\/static\/style\.css$/, (req, res) => send(res, 200, CSS, 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=300' })],
    ['GET', /^\/healthz$/, (req, res) => json(res, { ok: true })],

    // ───────────── 给 Agent 读的纯文本 ─────────────
    ['GET', /^\/llms\.txt$/, (req, res) => markdown(res, llmsTxt(baseUrl(req), svc.stats(), svc.tags()))],
    ['GET', /^\/search\.md$/, (req, res, m, url) => {
      const q = url.searchParams.get('q') ?? '';
      markdown(res, formatSearch(svc.search(q, { limit: Number(url.searchParams.get('limit') ?? 10) }), q));
    }],
    ['GET', /^\/feed\.md$/, (req, res, m, url) => {
      const kind = url.searchParams.get('kind') ?? 'new';
      if (kind === 'mine') throw new HttpError(400, 'kind=mine 需要身份，请用 /api/feed 或 MCP');
      markdown(res, formatFeed(svc.feed({ owner_id: null }, { kind, since: url.searchParams.get('since') ?? undefined, limit: url.searchParams.get('limit') ?? 10 })));
    }],

    // ───────────── 接口 ─────────────
    ['GET', /^\/api\/stats$/, (req, res) => json(res, svc.stats())],
    ['GET', /^\/api\/guides$/, (req, res, m, url) => json(res, {
      guides: svc.search(url.searchParams.get('q') ?? '', { tag: url.searchParams.get('tag') || undefined, limit: Number(url.searchParams.get('limit') ?? 20) }),
    })],
    ['GET', /^\/api\/guides\/([\w-]+)$/, (req, res, m) => json(res, svc.getGuide(m[1], { viewer: optionalOwner(req) ?? anonViewer(req, 'api'), source: 'agent' }))],
    ['GET', /^\/api\/profiles\/([^/]+)$/, (req, res, m) => json(res, svc.profile(decodeURIComponent(m[1])))],
    ['GET', /^\/api\/proposals\/([\w-]+)$/, (req, res, m) => json(res, svc.getProposal(m[1]))],
    ['POST', /^\/api\/agents\/register$/, async (req, res) => {
      limitRegister(req);
      json(res, svc.registerAgent(await body(req)), 201);
    }],
    ['POST', /^\/api\/guides$/, async (req, res) => json(res, svc.publishGuide(auth(req), await body(req)), 201)],
    ['POST', /^\/api\/guides\/([\w-]+)\/runs$/, async (req, res, m) => json(res, svc.reportRun(auth(req), m[1], await body(req)), 201)],
    ['POST', /^\/api\/guides\/([\w-]+)\/proposals$/, async (req, res, m) => json(res, svc.propose(auth(req), m[1], await body(req)), 201)],
    ['POST', /^\/api\/proposals\/([\w-]+)\/verifications$/, async (req, res, m) => json(res, svc.verifyProposal(auth(req), m[1], await body(req)), 201)],
    ['POST', /^\/api\/proposals\/([\w-]+)\/review$/, async (req, res, m) => json(res, svc.reviewProposal(auth(req), m[1], await body(req)))],
    ['GET', /^\/api\/inbox$/, (req, res) => json(res, svc.inbox(auth(req)))],
    ['GET', /^\/api\/feed$/, (req, res, m, url) => json(res, svc.feed(auth(req), { kind: url.searchParams.get('kind') ?? 'mine', since: url.searchParams.get('since') ?? undefined, limit: url.searchParams.get('limit') ?? 10 }))],
    ['POST', /^\/api\/runs$/, async (req, res) => {
      const b = await body(req);
      json(res, svc.startRun(auth(req), b.guide_id, { env: b.env }), 201);
    }],
    ['GET', /^\/api\/runs\/([\w-]+)$/, (req, res, m) => {
      const a = auth(req);
      svc.runRow(m[1], a.owner_id);
      json(res, svc.runState(m[1]));
    }],
    ['POST', /^\/api\/runs\/([\w-]+)\/steps$/, async (req, res, m) => json(res, svc.stepResult(auth(req), m[1], await body(req)))],
    ['POST', /^\/api\/runs\/([\w-]+)\/finish$/, async (req, res, m) => json(res, svc.finishRun(auth(req), m[1], await body(req)))],
    ['POST', /^\/api\/login-links$/, (req, res) => json(res, svc.createLoginLink(auth(req)), 201)],
    ['POST', /^\/api\/uploads$/, async (req, res) => {
      const up = svc.saveUpload(auth(req), await body(req, 2.2 * 1024 * 1024));
      json(res, { ...up, url: baseUrl(req) + up.path }, 201);
    }],
    ['POST', /^\/api\/usage$/, async (req, res) => json(res, svc.reportUsage(auth(req), (await body(req)).items))],

    // 远程 MCP（Streamable HTTP，无状态 JSON 响应）
    ['POST', /^\/mcp$/, async (req, res) => {
      const msg = await body(req);
      const handler = mcpHandlerFor(req);
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(handler))).filter(Boolean);
        return out.length ? json(res, out) : send(res, 202, '');
      }
      const out = await handler(msg);
      return out ? json(res, out) : send(res, 202, '');
    }],
    ['GET', /^\/mcp$/, (req, res) => send(res, 405, 'Method Not Allowed', 'text/plain', { allow: 'POST' })],
    ['DELETE', /^\/mcp$/, (req, res) => send(res, 405, 'Method Not Allowed', 'text/plain', { allow: 'POST' })],
  ];

  function baseUrl(req) {
    return publicUrl ?? `http://${req.headers.host ?? 'localhost'}`;
  }

  function guideMarkdown(req, gid) {
    const g = svc.getGuide(gid, { viewer: optionalOwner(req) ?? anonViewer(req, 'api'), source: 'agent' });
    return formatGuide(g, { webUrl: (p) => baseUrl(req) + p });
  }

  function auth(req) {
    const h = req.headers.authorization ?? '';
    return svc.authenticate(h.startsWith('Bearer ') ? h.slice(7).trim() : null);
  }

  function optionalOwner(req) {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return null;
    try { return svc.authenticate(h.slice(7).trim()).owner_id; } catch { return null; }
  }

  function meInfo(req) {
    const me = svc.sessionOwner(cookie(req, COOKIE));
    if (!me) return null;
    const pending = svc.db.prepare("SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ? AND status = 'pending'").get(me.owner_id).n;
    return { ...me, runs: svc.activeRuns(me.owner_id), pending };
  }

  function requireMe(req, f) {
    const me = svc.sessionOwner(cookie(req, COOKIE));
    if (!me) throw new HttpError(401, '请先登录：让你的 Agent 调用 caiguo_console_link 生成登录链接');
    if (!f || f.csrf !== me.csrf) throw new HttpError(403, '页面已过期，请刷新后再试');
    return me;
  }

  function anonViewer(req, kind) {
    const raw = `${req.socket.remoteAddress}|${req.headers['user-agent'] ?? ''}`;
    return `${kind}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  }

  function limitRegister(req) {
    const ip = req.socket.remoteAddress ?? '?';
    const now = Date.now();
    const hits = (registerHits.get(ip) ?? []).filter((t) => now - t < 3600e3);
    if (hits.length >= 30) throw new HttpError(429, '注册太频繁，请稍后再试');
    hits.push(now);
    registerHits.set(ip, hits);
  }

  function mcpHandlerFor(req) {
    const base = baseUrl(req);
    const agent = () => auth(req);
    const viewer = () => { try { return agent().owner_id; } catch { return anonViewer(req, 'api'); } };
    const client = {
      webUrl: (p) => base + p,
      search: async ({ q, tag, limit }) => svc.search(q, { tag, limit }),
      getGuide: async (id) => svc.getGuide(id, { viewer: viewer(), source: 'agent' }),
      start: async (gid, env) => svc.startRun(agent(), gid, { env }),
      next: async (rid, b) => svc.stepResult(agent(), rid, b),
      runState: async (rid) => { svc.runRow(rid, agent().owner_id); return svc.runState(rid); },
      finish: async (rid, b) => svc.finishRun(agent(), rid, b),
      publish: async (c) => svc.publishGuide(agent(), c),
      upload: async ({ data, mime }) => { const up = svc.saveUpload(agent(), { data, mime }); return { ...up, url: base + up.path }; },
      reportRun: async (id, b) => svc.reportRun(agent(), id, b),
      propose: async (id, b) => svc.propose(agent(), id, b),
      verify: async (pid, b) => svc.verifyProposal(agent(), pid, b),
      review: async (pid, b) => svc.reviewProposal(agent(), pid, b),
      feed: async (o) => svc.feed(agent(), o),
      consoleLink: async () => svc.createLoginLink(agent()),
    };
    return createMcpHandler({ name: 'caiguo', version: '0.2.0', instructions: INSTRUCTIONS, tools: TOOLS, call: (n, a) => callTool(client, n, a) });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      for (const [method, re, fn] of routes) {
        if (req.method !== method) continue;
        const m = url.pathname.match(re);
        if (m) return await fn(req, res, m, url);
      }
      throw new HttpError(404, '页面不存在');
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) console.error(e);
      const msg = status >= 500 ? '服务器内部错误' : e.message;
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return json(res, { error: msg }, status);
      if (/\.(md|txt)$/.test(url.pathname)) return markdown(res, `错误：${msg}`, status);
      return html(res, V.renderMessage({ title: status === 404 ? '找不到' : '出错了', text: msg, me: null }), status);
    }
  };
}

function wantsMarkdown(req) {
  const a = req.headers.accept ?? '';
  return a.includes('text/markdown') && !a.includes('text/html');
}

function cookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function send(res, status, payload, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers });
  res.end(payload);
}

function json(res, data, status = 200) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function markdown(res, text, status = 200) {
  send(res, status, text, 'text/markdown; charset=utf-8');
}

function html(res, pageHtml, status = 200) {
  send(res, status, pageHtml, 'text/html; charset=utf-8', {
    'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'none'; form-action 'self'; frame-ancestors 'self'",
    'referrer-policy': 'same-origin',
  });
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, '请求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function body(req, max = MAX_BODY) {
  const text = await readBody(req, max);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON');
  }
}

async function form(req) {
  const text = await readBody(req, 64 * 1024);
  return Object.fromEntries(new URLSearchParams(text));
}
