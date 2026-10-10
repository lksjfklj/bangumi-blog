// blog.test.js - 文章列表过滤：关键词总数 / 草稿可见性 / 草稿详情权限
// 背景：列表查询和总数查询原本各拼一套 WHERE，加上关键词搜索后只有列表带了 q，
// 于是搜「正文」列表只剩 1 条、total 却还是全部已发布数（分页能翻出空白页）。
// 草稿可见性必须只认登录会话：?status=all 对匿名访客不能有任何效果，
// 未发布文章也不能被没登录的人从详情接口读到。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 必须赶在 require('../src/db') 之前：config.js 只在"环境里还没有这个变量"时读 .env
const tmpDb = path.join(os.tmpdir(), 'bgm-blog-test-' + process.pid + '.db');
process.env.DB_FILE = tmpDb;

const express = require('express');
const { initDb, pool, db } = require('../src/db');
const blog = require('../src/routes/blog');
const { toPublished, normSlug, slugError, toIsoUtc } = require('../src/query');

initDb();

pool.query("INSERT INTO posts (slug, title, summary, content, published) VALUES (?,?,?,?,?)",
  ['p-live', '已发布 A', '摘要里有秘封两个字', '正文 A', 1]);
pool.query("INSERT INTO posts (slug, title, summary, content, published) VALUES (?,?,?,?,?)",
  ['p-live2', '已发布 B', '', '内容 B', 1]);
pool.query("INSERT INTO posts (slug, title, summary, content, published) VALUES (?,?,?,?,?)",
  ['p-draft', '草稿 C', '', '草稿里的正文', 0]);
pool.query("INSERT INTO tags (name) VALUES (?)", ['测试标签']);
pool.query("INSERT INTO post_tags (post_id, tag_id) VALUES ((SELECT id FROM posts WHERE slug = ?), (SELECT id FROM tags WHERE name = ?))", ['p-live', '测试标签']);

const app = express();
// 真实站点由会话中间件注入 req.user，这里用请求头模拟"站长本人 / 匿名"
app.use((req, res, next) => { req.user = req.headers['x-test-owner'] ? { is_owner: 1, kind: 'user' } : null; next(); });
app.use('/api/blog', blog);
const server = app.listen(0);
const asOwner = { headers: { 'x-test-owner': '1' } };

async function list(query, opts) {
  const port = server.address().port;
  const res = await fetch('http://127.0.0.1:' + port + '/api/blog/posts' + query, opts);
  return { status: res.status, body: await res.json() };
}

after(() => {
  server.close();
  db.close(); // Windows 上句柄没关就删不掉临时库
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* 可能不存在 */ } }
});

test('匿名：只出已发布，?status=all 没有任何效果', async () => {
  const plain = await list('?size=50');
  assert.equal(plain.body.total, 2);
  assert.deepEqual(plain.body.data.map(p => p.slug).sort(), ['p-live', 'p-live2']);

  const sneaky = await list('?size=50&status=all');
  assert.equal(sneaky.body.total, 2, '匿名带 status=all 也只能看到已发布');
  assert.ok(!sneaky.body.data.some(p => p.slug === 'p-draft'), '草稿不能出现在匿名列表里');

  const draftOnly = await list('?size=50&status=draft');
  assert.equal(draftOnly.body.total, 2, '匿名指定 draft 同样无效');
});

test('关键词搜索：total 与列表用同一套条件（旧实现总数永远等于全部已发布数）', async () => {
  const hit = await list('?size=50&q=' + encodeURIComponent('正文'));
  assert.equal(hit.body.data.length, 1, '已发布里只有一篇正文命中（另一篇是草稿）');
  assert.equal(hit.body.total, 1, 'total 必须跟着关键词走，否则「共 N 篇」和分页都是错的');
  assert.equal(hit.body.data[0].slug, 'p-live');

  const none = await list('?size=50&q=' + encodeURIComponent('不存在的关键词'));
  assert.equal(none.body.total, 0);

  // 通配符必须被转义：% 只是普通字符
  const wildcard = await list('?size=50&q=' + encodeURIComponent('%'));
  assert.equal(wildcard.body.total, 0, '用户输入的 % 不能被当成 LIKE 通配符');
});

test('标签过滤：total 同样跟着过滤条件', async () => {
  const d = await list('?size=50&tag=' + encodeURIComponent('测试标签'));
  assert.equal(d.body.total, 1);
  assert.equal(d.body.data[0].slug, 'p-live');
});

test('站长：status=all 能看到草稿，status=draft 只看草稿', async () => {
  const all = await list('?size=50&status=all', asOwner);
  assert.equal(all.body.total, 3);
  assert.ok(all.body.data.some(p => p.slug === 'p-draft' && p.published === 0));

  const drafts = await list('?size=50&status=draft', asOwner);
  assert.equal(drafts.body.total, 1);
  assert.equal(drafts.body.data[0].slug, 'p-draft');
});

test('分页参数：越界值被夹回合法范围', async () => {
  const big = await list('?size=9999&page=-3', asOwner);
  assert.equal(big.body.size, 50);
  assert.equal(big.body.page, 1);
});

test('草稿详情：匿名 404，站长能读到正文', async () => {
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/api/blog/posts/p-draft';
  assert.equal((await fetch(url)).status, 404);
  const mine = await fetch(url, asOwner);
  assert.equal(mine.status, 200);
  const post = await mine.json();
  assert.equal(post.published, 0);
  assert.ok(post.html.includes('草稿里的正文'));
});

test('toPublished: 字符串 "0" 不能被当成发布', () => {
  assert.equal(toPublished(0), 0);
  assert.equal(toPublished('0'), 0, '表单/curl 送来字符串 0 时旧写法 `published ? 1 : 0` 会误发布');
  assert.equal(toPublished(false), 0);
  assert.equal(toPublished(1), 1);
  assert.equal(toPublished('1'), 1);
  assert.equal(toPublished(true), 1);
  assert.equal(toPublished(undefined), 1, '缺省按发布，保持旧行为');
  assert.equal(toPublished(null), 1);
  assert.equal(toPublished(''), 1);
  assert.equal(toPublished(undefined, 0), 0);
});

test('normSlug / slugError: 空白折 -，路径敏感字符直接拒绝', () => {
  assert.equal(normSlug('  hello world  '), 'hello-world');
  assert.equal(normSlug('啥玩意'), '啥玩意', '中文 slug 保留，前端负责 encodeURIComponent');
  assert.equal(normSlug('a/b'), 'a/b');
  assert.equal(normSlug(''), '');
  assert.equal(normSlug(null), '');
  assert.equal(normSlug('x'.repeat(300)).length, 200);
  assert.equal(slugError('hello-world'), '');
  assert.ok(slugError(''));
  assert.ok(slugError('a/b'));
  assert.ok(slugError('a?b'));
  assert.ok(slugError('a#b'));
  assert.ok(slugError('a%20b'));
});

test('toIsoUtc: SQLite 的 UTC 文本补上 Z，其它原样返回', () => {
  assert.equal(toIsoUtc('2026-08-28 05:16:09'), '2026-08-28T05:16:09Z');
  assert.equal(toIsoUtc('2026-08-31T07:12:21.445Z'), '2026-08-31T07:12:21.445Z');
  assert.equal(toIsoUtc(null), null);
});
