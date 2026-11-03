// 数据库备份：用 SQLite 的 VACUUM INTO 在服务运行时生成一份一致的副本，按日期命名，只保留最近 N 份。
// 用法：node --no-warnings=ExperimentalWarning scripts/backup.js [--db data/caiguo.db] [--out backups] [--keep 14]
// 建议用 systemd timer 或 cron 每天跑一次，再把 backups/ 同步到另一台机器或对象存储（见 docs/DEPLOY.md）。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const dbPath = resolve(opt('--db', process.env.CAIGUO_DB ?? 'data/caiguo.db'));
const outDir = resolve(opt('--out', 'backups'));
const keep = Math.max(1, Number(opt('--keep', 14)) || 14);

if (!existsSync(dbPath)) {
  console.error(`没有找到数据库 ${dbPath}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const target = join(outDir, `caiguo-${stamp}.db`);
if (existsSync(target)) rmSync(target);

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
db.close();

// 校验副本能打开、表都在
const check = new DatabaseSync(target, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get();
const guides = check.prepare('SELECT COUNT(*) AS n FROM guides').get().n;
check.close();
if (Object.values(ok)[0] !== 'ok') {
  console.error(`备份校验失败：${JSON.stringify(ok)}`);
  process.exit(1);
}

const old = readdirSync(outDir).filter((f) => /^caiguo-\d{8}-\d{6}\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) rmSync(join(outDir, f));
console.log(`已备份到 ${target}（${(statSync(target).size / 1024).toFixed(0)} KB，${guides} 篇笔记）；保留最近 ${keep} 份，删除了 ${old.length} 份旧的`);
