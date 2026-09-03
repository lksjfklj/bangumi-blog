// enrich.test.js - VNDB 回填管道集成测试（打桩 vndb 网络层，不真连外网）
// 依赖本地开发库：先落 3 条 galgame 假条目 -> 跑一轮回填 -> 校验 map/ext -> 清理
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// 1) 先加载真实 vndb 模块并打桩网络方法（library.js 之后 require 到的是同一 exports 对象）
const vndb = require('../src/vndb');
const calls = [];
const mkVn = (id, title, released, extra = {}) => ({
  id, title,
  alttitle: extra.alttitle || '',
  titles: extra.titles || [],
  aliases: extra.aliases || [],
  released: released || '',
  rating: extra.rating || 78,
  votecount: extra.votecount || 123,
  popularity: extra.popularity || 55,
  platforms: extra.platforms || ['win'],
  developers: extra.developers || [{ name: 'Key' }],
  olang: extra.olang || 'ja',
  image: extra.image || { url: 'https://t.vndb.org/sf/00/abc.jpg' },
  length: extra.length || 10
});
const FAKE_BY_QUERY = {
  'CLANNAD': [mkVn('v123', 'CLANNAD', '2004-04-28', { developers: [{ name: 'Key' }] })],
  'こみっくパーティー': [mkVn('v66', 'Comic Party', '2001-05-25', {
    titles: [{ lang: 'ja', title: 'こみっくパーティー' }, { lang: 'en', latin: 'Comic Party' }]
  })]
};
vndb.vnSearch = async (q) => { calls.push('search:' + q); return FAKE_BY_QUERY[q] || []; };
vndb.vnById = async (id) => { calls.push('byId:' + id); return id === 'v123' ? mkVn('v123', 'CLANNAD', '2004-04-28') : null; };

const { runVndbSync, vndbStatus, mergeExt } = require('../src/library');
const { pool } = require('../src/db');

const IDS = [90000101, 90000102, 90000103]; // CLANNAD / こみっくパーティー / 不存在
const CAT = 'galgame';
const q = (sql, p = []) => pool.query(sql, p)[0];

before(async () => {
  for (const id of IDS) {
    await pool.query("DELETE FROM library_subjects WHERE subject_id = ? AND category = ?", [id, CAT]);
    await pool.query("DELETE FROM library_source_map WHERE bgm_id = ? AND source = 'vndb'", [id]);
  }
  await pool.query("DELETE FROM library_sync WHERE key LIKE 'vndb_%'");
  await pool.query("INSERT INTO library_sync (key, value) VALUES ('vndb_cursor', '0') ON CONFLICT(key) DO UPDATE SET value = '0'");
  await pool.query(
    `INSERT INTO library_subjects (subject_id, category, name, name_cn, air_date, ext)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [IDS[0], CAT, 'CLANNAD', 'CLANNAD', '2004-04-28', '{"custom":{"x":1}}']
  );
  await pool.query(
    `INSERT INTO library_subjects (subject_id, category, name, name_cn, air_date, ext)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [IDS[1], CAT, 'こみっくパーティー', 'Comic Party', '2001-05-25', '{}']
  );
  await pool.query(
    `INSERT INTO library_subjects (subject_id, category, name, name_cn, air_date, ext)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [IDS[2], CAT, '完全不存在之作品', '完全不存在之作品', '1999-01-01', '{}']
  );
});

after(async () => {
  for (const id of IDS) {
    await pool.query("DELETE FROM library_subjects WHERE subject_id = ? AND category = ?", [id, CAT]);
    await pool.query("DELETE FROM library_source_map WHERE bgm_id = ? AND source = 'vndb'", [id]);
  }
  await pool.query("DELETE FROM library_sync WHERE key LIKE 'vndb_%'");
});

test('mergeExt: 保留其他来源键、整体覆盖 vndb 键', () => {
  const out = JSON.parse(mergeExt('{"custom":{"x":1}}', { id: 'v123' }));
  assert.deepEqual(out.custom, { x: 1 });
  assert.equal(out.vndb.id, 'v123');
  assert.equal(JSON.parse(mergeExt('not-json', { id: 'v1' })).vndb.id, 'v1');
});

test('runVndbSync: 首轮匹配 ok 两条 / nomatch 一条，落 map + ext', async () => {
  const res = await runVndbSync({});
  assert.equal(res.ok, true);
  assert.equal(res.done, true);
  assert.equal(res.stats.processed, 3);
  assert.equal(res.stats.ok, 2);
  assert.equal(res.stats.nomatch, 1);
  assert.equal(res.stats.skip, 0);
  // map 落库
  const m1 = q('SELECT * FROM library_source_map WHERE bgm_id = ? AND source = ?', [IDS[0], 'vndb'])[0];
  assert.equal(m1.status, 'ok');
  assert.equal(m1.source_id, 'v123');
  assert.ok(m1.match_score >= 0.999);
  const m2 = q('SELECT * FROM library_source_map WHERE bgm_id = ? AND source = ?', [IDS[1], 'vndb'])[0];
  assert.equal(m2.source_id, 'v66');
  const m3 = q('SELECT * FROM library_source_map WHERE bgm_id = ? AND source = ?', [IDS[2], 'vndb'])[0];
  assert.equal(m3.status, 'nomatch');
  // ext 合并：vndb 摘要写入且原 custom 键保留
  const row = q("SELECT ext FROM library_subjects WHERE subject_id = ? AND category = 'galgame'", [IDS[0]])[0];
  const ext = JSON.parse(row.ext);
  assert.equal(ext.vndb.id, 'v123');
  assert.equal(ext.vndb.developers[0], 'Key');
  assert.deepEqual(ext.custom, { x: 1 });
});

test('runVndbSync: 幂等——30 天宽限期内再跑全部 skip', async () => {
  const res = await runVndbSync({});
  assert.equal(res.ok, true);
  assert.equal(res.done, true);
  assert.equal(res.stats.processed, 3);
  assert.equal(res.stats.skip, 3);
});

test('vndbStatus: 汇总数与 recent 清单可见', async () => {
  const st = await vndbStatus();
  assert.equal(st.summary.candidates, 3);
  assert.equal(st.summary.matched, 2);
  assert.equal(st.summary.nomatch, 1);
  assert.equal(st.summary.untouched, 0);
  assert.ok(Array.isArray(st.recent) && st.recent.length >= 3);
  assert.equal(st.source, 'vndb');
});
