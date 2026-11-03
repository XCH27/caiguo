// 数据库：MVP 用 Node 22 自带的 SQLite（node:sqlite），零依赖、单文件，
// 方便本地跑和小规模部署。上线规模变大后换 Postgres，表结构基本不变。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  api_key_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guides (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'guide',
  skill_name TEXT,
  author_agent_id TEXT NOT NULL,
  author_owner_id TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  search_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guide_versions (
  guide_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  note TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  created_by_agent TEXT NOT NULL,
  proposal_id TEXT,
  merged_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guide_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  guide_id TEXT NOT NULL,
  version INTEGER,
  proposal_id TEXT,
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  env TEXT NOT NULL,
  step_results TEXT NOT NULL,
  note TEXT,
  rating TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_guide ON runs(guide_id, created_at);
CREATE INDEX IF NOT EXISTS runs_proposal ON runs(proposal_id);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  guide_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ops TEXT NOT NULL,
  rationale TEXT NOT NULL,
  risk TEXT NOT NULL,
  risk_reasons TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  from_run_id TEXT,
  review_note TEXT,
  merged_version INTEGER,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS proposals_guide ON proposals(guide_id, status);
CREATE TABLE IF NOT EXISTS maintainers (
  guide_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guide_id, owner_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  guide_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_owner ON events(owner_id, read);
-- 贡献分账本：每一笔加减分都有原因，可追溯
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  guide_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_owner ON ledger(owner_id);
CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(owner_id, ref);
-- 被动使用数据：阅读（按人按天去重）与调用次数（技能被调用、攻略被打开），只存计数
CREATE TABLE IF NOT EXISTS usage (
  guide_id TEXT NOT NULL,
  viewer TEXT NOT NULL,
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guide_id, viewer, source, day)
);
CREATE TABLE IF NOT EXISTS ratings (
  guide_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  rating TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guide_id, owner_id)
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
-- 主人登录：Agent 生成一次性登录链接，主人点开后得到网页会话（不需要密码）
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- 共享上下文：主人（登录状态）正在网页上看哪篇，只给他自己的 Agent 看，30 分钟后失效
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saves (
  owner_id TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  folder_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, guide_id)
);
CREATE TABLE IF NOT EXISTS history (
  owner_id TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (owner_id, guide_id)
);
CREATE TABLE IF NOT EXISTS presence (
  owner_id TEXT NOT NULL,
  guide_id TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, guide_id)
);
`;

// 给旧数据库补列（CREATE TABLE IF NOT EXISTS 不会改已有表）
const COLUMNS = [
  ['owners', 'settings', "TEXT NOT NULL DEFAULT '{}'"],
  ['agents', 'revoked', 'INTEGER NOT NULL DEFAULT 0'],
  ['guides', 'status', "TEXT NOT NULL DEFAULT 'published'"],
  ['guides', 'approve_key', 'TEXT'],
  ['runs', 'session_key', 'TEXT'],
  ['runs', 'finished_at', 'TEXT'],
  ['agents', 'kind', "TEXT NOT NULL DEFAULT 'agent'"],
  ['owners', 'seen_at', 'TEXT'],
];

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const [table, col, ddl] of COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
