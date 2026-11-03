// 把某个主人设为管理员（能打开 /admin 处理举报、下架内容、封禁账号）。
// 用法：node --no-warnings=ExperimentalWarning scripts/make-admin.js <踩过号> [--revoke] [--db data/caiguo.db]
import { openDb } from '../server/db.js';

const args = process.argv.slice(2);
const handle = args.find((a) => !a.startsWith('--'));
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : (process.env.CAIGUO_DB ?? 'data/caiguo.db');
if (!handle) { console.error('用法：node scripts/make-admin.js <踩过号> [--revoke]'); process.exit(1); }
const db = openDb(dbPath);
const o = db.prepare('SELECT id FROM owners WHERE handle = ?').get(handle);
if (!o) { console.error(`没有 ${handle} 这个人`); process.exit(1); }
db.prepare('UPDATE owners SET role = ? WHERE id = ?').run(args.includes('--revoke') ? null : 'admin', o.id);
console.log(`${handle} ${args.includes('--revoke') ? '不再是' : '现在是'}管理员`);
