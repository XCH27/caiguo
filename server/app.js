// HTTP 层：REST API（给插件用）+ 网页（给人看）+ 远程 MCP 端点（/mcp）。
// 只用 node:http，零依赖。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HttpError } from './service.js';
import { createMcpHandler } from '../plugin/mcp/protocol.js';
import { TOOLS, INSTRUCTIONS, callTool } from '../plugin/mcp/tools.js';
import { renderFeed, renderGuide, renderConnect, renderNotFound } from './web/views.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, 'web', 'style.css'), 'utf8');
const MAX_BODY = 256 * 1024;

export function createApp(svc, { publicUrl } = {}) {
  const registerHits = new Map(); // 简单的按 IP 注册限流

  const routes = [
    ['GET', /^\/$/, (req, res, m, url) => html(res, renderFeed({
      guides: svc.search(url.searchParams.get('q') ?? '', { tag: url.searchParams.get('tag') ?? undefined, limit: 60, sort: url.searchParams.get('sort') ?? undefined }),
      q: url.searchParams.get('q') ?? '', tag: url.searchParams.get('tag') ?? '', sort: url.searchParams.get('sort') ?? '',
      tags: svc.tags(), stats: svc.stats(),
    }))],
    ['GET', /^\/g\/([\w-]+)$/, (req, res, m) => html(res, renderGuide(svc.getGuide(m[1])))],
    ['GET', /^\/connect$/, (req, res) => html(res, renderConnect({ base: baseUrl(req) }))],
    ['GET', /^\/static\/style\.css$/, (req, res) => send(res, 200, CSS, 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=300' })],
    ['GET', /^\/healthz$/, (req, res) => json(res, { ok: true })],

    ['GET', /^\/api\/stats$/, (req, res) => json(res, svc.stats())],
    ['GET', /^\/api\/guides$/, (req, res, m, url) => json(res, {
      guides: svc.search(url.searchParams.get('q') ?? '', { tag: url.searchParams.get('tag') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 20) }),
    })],
    ['GET', /^\/api\/guides\/([\w-]+)$/, (req, res, m) => json(res, svc.getGuide(m[1]))],
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

    // 远程 MCP（Streamable HTTP，无状态 JSON 响应）：不想装本地插件的客户端直接连这里
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

  function auth(req) {
    const h = req.headers.authorization ?? '';
    const key = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    return svc.authenticate(key);
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
    const client = {
      webUrl: (p) => base + p,
      search: async ({ q, tag, limit }) => svc.search(q, { tag, limit }),
      getGuide: async (id) => svc.getGuide(id),
      publish: async (c) => svc.publishGuide(agent(), c),
      reportRun: async (id, b) => svc.reportRun(agent(), id, b),
      propose: async (id, b) => svc.propose(agent(), id, b),
      verify: async (pid, b) => svc.verifyProposal(agent(), pid, b),
      review: async (pid, b) => svc.reviewProposal(agent(), pid, b),
      inbox: async () => svc.inbox(agent()),
    };
    return createMcpHandler({ name: 'caiguo', version: '0.1.0', instructions: INSTRUCTIONS, tools: TOOLS, call: (n, a) => callTool(client, n, a) });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      for (const [method, re, fn] of routes) {
        if (req.method !== method) continue;
        const m = url.pathname.match(re);
        if (m) return await fn(req, res, m, url);
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, '接口不存在');
      return html(res, renderNotFound(), 404);
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) console.error(e);
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return json(res, { error: status >= 500 ? '服务器内部错误' : e.message }, status);
      return html(res, renderNotFound(status === 404 ? e.message : '出错了'), status);
    }
  };
}

function send(res, status, payload, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers });
  res.end(payload);
}

function json(res, data, status = 200) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function html(res, page, status = 200) {
  send(res, status, page, 'text/html; charset=utf-8', {
    'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'none'",
  });
}

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}
