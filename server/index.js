import { createServer } from 'node:http';
import { openDb } from './db.js';
import { Caiguo } from './service.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.CAIGUO_DB ?? 'data/caiguo.db';
const svc = new Caiguo(openDb(dbPath));
const server = createServer(createApp(svc, { publicUrl: process.env.CAIGUO_PUBLIC_URL }));

// 定时检查可以自动合并的修订
setInterval(() => {
  try { svc.sweepAutoMerge(); } catch (e) { console.error('auto-merge sweep failed', e); }
}, 10 * 60 * 1000).unref();

server.listen(port, () => {
  console.log(`踩过 Caiguo 已启动：http://localhost:${port}  （数据库 ${dbPath}）`);
  console.log(`远程 MCP 端点：http://localhost:${port}/mcp`);
});
