import { createServer } from 'node:http';
import { openDb } from './db.js';
import { Caiguo } from './service.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.CAIGUO_DB ?? 'data/caiguo.db';
// 短信验证码：配置 CAIGUO_SMS_WEBHOOK 后，把 { phone, code } POST 给你的短信服务（如阿里云短信、腾讯云短信的转发服务）。
// 不配置时是开发模式：验证码直接显示在登录页上，只能用于本地演示。
const smsWebhook = process.env.CAIGUO_SMS_WEBHOOK;
const sms = smsWebhook
  ? (phone, code) => {
    fetch(smsWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.CAIGUO_SMS_TOKEN ? { authorization: `Bearer ${process.env.CAIGUO_SMS_TOKEN}` } : {}) },
      body: JSON.stringify({ phone, code, template: 'login' }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => console.error('短信发送失败', e.message));
  }
  : null;
const svc = new Caiguo(openDb(dbPath), { sms, phonePepper: process.env.CAIGUO_PHONE_PEPPER ?? 'caiguo' });
const server = createServer(createApp(svc, { publicUrl: process.env.CAIGUO_PUBLIC_URL }));

// 定时检查可以自动合并的修订
setInterval(() => {
  try { svc.sweepAutoMerge(); } catch (e) { console.error('auto-merge sweep failed', e); }
}, 10 * 60 * 1000).unref();

server.listen(port, () => {
  console.log(`踩过 Caiguo 已启动：http://localhost:${port}  （数据库 ${dbPath}）`);
  console.log(`远程 MCP 端点：http://localhost:${port}/mcp`);
  if (!sms) console.log('短信：开发模式（没有配置 CAIGUO_SMS_WEBHOOK，验证码会显示在登录页上）');
});
