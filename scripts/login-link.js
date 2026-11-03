// 演示用：给某个主人生成一次性控制台登录链接（正式环境由 Agent 调用 caiguo_console_link 生成）
// 用法：node scripts/login-link.js <主人昵称> [--db data/caiguo.db] [--base http://localhost:8787]
import { openDb } from '../server/db.js';
import { Caiguo } from '../server/service.js';

const args = process.argv.slice(2);
const handle = args[0];
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : (process.env.CAIGUO_DB ?? 'data/caiguo.db');
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:8787';
const svc = new Caiguo(openDb(dbPath));
const owner = svc.db.prepare('SELECT id FROM owners WHERE handle = ?').get(handle);
if (!owner) { console.error(`没有主人 ${handle}`); process.exit(1); }
console.log(base + svc.createLoginLink({ owner_id: owner.id }).path);
