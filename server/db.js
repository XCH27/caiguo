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
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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
