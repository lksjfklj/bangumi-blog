// db.js - SQLite 数据层（Node 内置 node:sqlite，零原生依赖）
// 对外暴露与 mysql2 兼容的 pool.query / getConnection 接口，方便调用方无需大改
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const dbFile = config.db.file;
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache (
  cache_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bangumi_uid INTEGER UNIQUE,
  username TEXT,
  nickname TEXT,
  avatar TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER DEFAULT 0,
  password_hash TEXT,
  is_owner INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_local_username ON users(username) WHERE password_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT DEFAULT 'user',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  subject_type INTEGER DEFAULT 2,
  name TEXT,
  name_cn TEXT,
  image TEXT,
  score INTEGER DEFAULT 0,
  status INTEGER DEFAULT 0,
  ep_status INTEGER DEFAULT 0,
  comment TEXT,
  tags TEXT,
  updated_at INTEGER DEFAULT 0,
  UNIQUE (user_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_collections_user_status ON collections(user_id, status);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  content TEXT,
  published INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  published INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS library_subjects (
  subject_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  name TEXT DEFAULT '',
  name_cn TEXT DEFAULT '',
  image TEXT DEFAULT '',
  air_date TEXT DEFAULT '',
  rating_score REAL DEFAULT 0,
  rating_total INTEGER DEFAULT 0,
  rank INTEGER DEFAULT 0,
  platform TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  regions TEXT DEFAULT '[]',
  blocked INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT 0,
  PRIMARY KEY (subject_id, category)
);
CREATE INDEX IF NOT EXISTS idx_library_cat ON library_subjects(category, blocked);

CREATE TABLE IF NOT EXISTS library_sync (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function runQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  const args = Array.isArray(params) ? params : [];
  const firstWord = String(sql).trim().split(/\s+/)[0].toUpperCase();
  if (firstWord === 'SELECT' || firstWord === 'WITH' || firstWord === 'PRAGMA' || firstWord === 'EXPLAIN') {
    return [stmt.all(...args), undefined];
  }
  const r = stmt.run(...args);
  return [{ insertId: Number(r.lastInsertRowid), affectedRows: Number(r.changes) }];
}

function getConnection() {
  return {
    query: runQuery,
    beginTransaction: () => db.exec('BEGIN'),
    commit: () => db.exec('COMMIT'),
    rollback: () => db.exec('ROLLBACK'),
    release: () => {}
  };
}

const pool = {
  query: runQuery,
  getConnection
};

function ensureColumn(table, column, ddl) {
  const [cols] = runQuery(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function initDb() {
  // 兼容旧库：先补缺失列（多用户/权限体系），再建表/索引。
  // 注意：SCHEMA 中的部分索引（如 idx_users_local_username）引用了新列，
  // 旧库必须先 ALTER TABLE 补列，否则 db.exec(SCHEMA) 会因 "no such column" 整体失败。
  const migrations = [
    ['collections', 'subject_tags', 'subject_tags TEXT DEFAULT NULL'],
    ['users', 'password_hash', 'password_hash TEXT DEFAULT NULL'],
    ['users', 'is_owner', 'is_owner INTEGER DEFAULT 0'],
    ['sessions', 'kind', "kind TEXT DEFAULT 'user'"]
  ];
  for (const [table, column, ddl] of migrations) {
    try { ensureColumn(table, column, ddl); } catch (e) { console.error('[db] migrate fail', table, column, e.message); }
  }
  db.exec(SCHEMA);
  // 标记站长账号（OWNER_BANGUMI_UID 对应的 Bangumi 用户拥有全站写权限）
  try {
    if (config.ownerBangumiUid) {
      db.prepare('UPDATE users SET is_owner = 1 WHERE bangumi_uid = ?').run(config.ownerBangumiUid);
    }
  } catch (e) { /* ignore */ }
}

module.exports = { pool, initDb, db, dbFile };


