import { createServer } from 'node:http';
import { openDb } from './db.js';
import { Caiguo } from './service.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.CAIGUO_DB ?? 'data/caiguo.db';
const production = process.env.CAIGUO_ENV === 'production';

// 正式环境的启动检查：缺了这些就不启动（开发模式的验证码会显示在页面上，默认密钥谁都知道）
if (production) {
  const problems = [];
  if (!process.env.CAIGUO_SMS_WEBHOOK) problems.push('没有配置 CAIGUO_SMS_WEBHOOK（正式环境不能把验证码显示在页面上）');
  const pepper = process.env.CAIGUO_PHONE_PEPPER ?? '';
  if (pepper.length < 32 || pepper === 'caiguo') problems.push('CAIGUO_PHONE_PEPPER 要设成至少 32 位的随机串（生成：openssl rand -hex 32），并且以后不能再换');
  if (!String(process.env.CAIGUO_PUBLIC_URL ?? '').startsWith('https://')) problems.push('CAIGUO_PUBLIC_URL 要设成 https:// 开头的正式地址（登录 cookie 才会带 Secure）');
  if (problems.length) {
    console.error(`正式环境（CAIGUO_ENV=production）启动检查没有通过：\n- ${problems.join('\n- ')}\n详见 docs/DEPLOY.md`);
    process.exit(1);
  }
}
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
const db = openDb(dbPath);
const svc = new Caiguo(db, { sms, phonePepper: process.env.CAIGUO_PHONE_PEPPER ?? 'caiguo', allowVirtual: process.env.CAIGUO_ALLOW_VIRTUAL === '1' });
const server = createServer(createApp(svc, { publicUrl: process.env.CAIGUO_PUBLIC_URL, trustProxy: process.env.CAIGUO_TRUST_PROXY === '1' }));

// 定时检查可以自动采纳的带修改评论（验证数和天数够了）
setInterval(() => {
  try { svc.sweepAutoMerge(); } catch (e) { console.error('auto-merge sweep failed', e); }
}, 10 * 60 * 1000).unref();

server.listen(port, () => {
  console.log(`踩过 Caiguo 已启动：http://localhost:${port}  （数据库 ${dbPath}）`);
  console.log(`远程 MCP 端点：http://localhost:${port}/mcp`);
  if (!sms) console.log('短信：开发模式（没有配置 CAIGUO_SMS_WEBHOOK，验证码会显示在登录页上）');
  if (production && db.prepare("SELECT COUNT(*) AS n FROM guides WHERE tags LIKE '%\"示例\"%'").get().n) {
    console.warn('注意：数据库里还有演示数据（带“示例”标签的笔记），正式上线前请换一个空数据库');
  }
});

// systemd 停服务时先停止接新请求，再关数据库
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
