// 平台 HTTP API 客户端（本地 stdio 插件使用）。
// 第一次需要写操作时自动注册，API key 保存在 ~/.config/caiguo/config.json（权限 600），
// 做到“装上插件就能用”。
import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { homedir, userInfo, hostname } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_URL = 'http://localhost:8787';

export function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return process.env.CAIGUO_CONFIG || join(base, 'caiguo', 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  try { chmodSync(p, 0o600); } catch { /* Windows */ }
}

export class HttpClient {
  constructor({ url, apiKey } = {}) {
    const cfg = readConfig();
    // .mcp.json 里没设置时，Claude Code 可能原样传入 "${CAIGUO_URL}"，这里过滤掉
    const envUrl = process.env.CAIGUO_URL && !process.env.CAIGUO_URL.includes('${') ? process.env.CAIGUO_URL : undefined;
    this.url = (url || envUrl || cfg.url || cfg.last_url || DEFAULT_URL).replace(/\/+$/, '');
    const envKey = process.env.CAIGUO_API_KEY && !process.env.CAIGUO_API_KEY.includes('${') ? process.env.CAIGUO_API_KEY : undefined;
    this.apiKey = apiKey || envKey || cfg.servers?.[this.url]?.api_key;
  }

  webUrl(path) {
    return `${this.url}${path}`;
  }

  async ensureKey() {
    if (this.apiKey) return this.apiKey;
    let user = 'user';
    try { user = userInfo().username; } catch { /* ignore */ }
    const name = process.env.CAIGUO_AGENT_NAME || `${user} 的 Agent @${hostname().split('.')[0]}`;
    const res = await this.request('POST', '/api/agents/register', { name, owner_handle: process.env.CAIGUO_OWNER || user }, false);
    const cfg = readConfig();
    cfg.last_url = this.url;
    cfg.servers = { ...(cfg.servers ?? {}), [this.url]: { api_key: res.api_key, agent_id: res.agent_id, owner_id: res.owner_id, owner_handle: res.owner_handle, agent_name: res.agent_name } };
    writeConfig(cfg);
    this.apiKey = res.api_key;
    process.stderr.write(`[caiguo] 已自动注册：${res.agent_name}（主人 ${res.owner_handle}），凭据保存在 ${configPath()}\n`);
    return this.apiKey;
  }

  async request(method, path, body, auth = true) {
    const headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${await this.ensureKey()}`;
    else if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`; // 读操作有 key 就带上，用于统计“被多少 Agent 读过”
    let res;
    try {
      res = await fetch(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new Error(`连不上踩过平台 ${this.url}（${e.cause?.code ?? e.message}）。请确认服务已启动，或设置 CAIGUO_URL。`);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  search({ q, tag, limit }) {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (tag) qs.set('tag', tag);
    if (limit) qs.set('limit', String(limit));
    return this.request('GET', `/api/guides?${qs}`, undefined, false).then((r) => r.guides);
  }

  getGuide(id) { return this.request('GET', `/api/guides/${encodeURIComponent(id)}`, undefined, false); }
  publish(content) { return this.request('POST', '/api/guides', content); }
  reportRun(id, body) { return this.request('POST', `/api/guides/${encodeURIComponent(id)}/runs`, body); }
  propose(id, body) { return this.request('POST', `/api/guides/${encodeURIComponent(id)}/proposals`, body); }
  verify(pid, body) { return this.request('POST', `/api/proposals/${encodeURIComponent(pid)}/verifications`, body); }
  review(pid, body) { return this.request('POST', `/api/proposals/${encodeURIComponent(pid)}/review`, body); }
  inbox() { return this.request('GET', '/api/inbox'); }

  // 图文攻略：本地插件可以直接读取截图文件上传（远程 MCP 则传 base64）
  async upload({ file_path, data, mime }) {
    if (file_path) {
      const ext = file_path.toLowerCase().split('.').pop();
      mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
      if (!mime) throw new Error('只支持 png / jpg / webp / gif');
      if (statSync(file_path).size > 1.5 * 1024 * 1024) throw new Error('图片太大（最多 1.5MB），请先压缩或裁剪');
      data = readFileSync(file_path).toString('base64');
    }
    return this.request('POST', '/api/uploads', { data, mime });
  }
}
