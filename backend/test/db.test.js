// db.test.js - 迁移/初始化幂等性单测（对真实开发库执行，全部为幂等操作）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');

test('initDb: 重复执行不报错（CREATE IF NOT EXISTS + migrations 表去重）', () => {
  assert.doesNotThrow(() => initDb());
  assert.doesNotThrow(() => initDb());
});

test('initDb: 迁移记录表存在且版本号已落库', () => {
  assert.doesNotThrow(() => initDb());
  const { pool } = require('../src/db');
  const [rows] = pool.query('SELECT id FROM migrations ORDER BY id');
  assert.ok(Array.isArray(rows) && rows.length >= 3, '应有 >= 3 条迁移记录');
  assert.ok(rows.some(r => r.id === 2));
  assert.ok(rows.some(r => r.id === 3));
  assert.ok(rows.some(r => r.id === 4));
});

