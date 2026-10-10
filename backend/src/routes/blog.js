// routes/blog.js - 个人博客：文章/标签/管理
const express = require('express');
const md = require('markdown-it')({ html: true, linkify: true, breaks: false });
const { sanitizeHtmlSafe } = require('../sanitize');
const { pool } = require('../db');
const { requireAdmin, isOwnerUser } = require('../auth');
const { strParam, paging, escapeLike, LIKE_ESC, parseId, toIsoUtc, toPublished, normSlug, slugError } = require('../query');
const router = express.Router();

// 列表过滤条件只在这里拼一次，列表查询和总数查询共用同一份。
// 旧写法两边各拼一套，加了个关键词搜索后就漏了 q：列表只剩 1 条、total 还是全部已发布数，
// 「共 N 篇」对不上、分页还能翻出空白页。
// status 只在站长本人请求时生效：'all' 全部 / 'draft' 只看草稿 / 其余（含任何非站长）都只出已发布。
function listWhere({ owner, status, tag, q }) {
  const where = [];
  const args = [];
  if (owner && status === 'all') { /* 站长看全部（含草稿） */ }
  else if (owner && status === 'draft') where.push('p.published = 0');
  else where.push('p.published = 1');
  if (tag) {
    where.push('p.id IN (SELECT post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)');
    args.push(tag);
  }
  if (q) {
    // 转义 LIKE 通配符，避免用户输入的 % / _ 被当成模式
    where.push('(p.title LIKE ? ' + LIKE_ESC + ' OR p.summary LIKE ? ' + LIKE_ESC + ' OR p.content LIKE ? ' + LIKE_ESC + ')');
    const like = '%' + escapeLike(q) + '%';
    args.push(like, like, like);
  }
  return { whereSql: where.length ? ' WHERE ' + where.join(' AND ') : '', args };
}

// 文章列表（公开：只有已发布；站长本人可带 ?status=all|draft 看到自己的草稿）
router.get('/posts', async (req, res, next) => {
  try {
    // 参数全部经 query.js 归一化：size/page 可能是数组或 NaN，tag 可能是 ?tag[]=a 数组
    const tag = strParam(req.query.tag).trim();
    const q = strParam(req.query.q).trim();
    const status = strParam(req.query.status).trim();
    const { page, limit, offset } = paging(req.query, { defSize: 10, maxSize: 50 });
    const { whereSql, args } = listWhere({ owner: isOwnerUser(req.user), status, tag, q });
    const [rows] = await pool.query(
      `SELECT p.id, p.slug, p.title, p.summary, p.published, p.created_at, p.updated_at,
          (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tags
       FROM posts p` + whereSql + ' ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?',
      args.concat([limit, offset])
    );
    const [cnt] = await pool.query('SELECT COUNT(*) AS total FROM posts p' + whereSql, args);
    const list = rows.map(r => ({
      ...r,
      tags: r.tags ? r.tags.split(',') : [],
      created_at: toIsoUtc(r.created_at),
      updated_at: toIsoUtc(r.updated_at)
    }));
    res.json({ data: list, total: cnt[0].total, page, size: limit });
  } catch (e) { next(e); }
});

// 文章详情（slug）
router.get('/posts/:slug', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tags
       FROM posts p WHERE p.slug = ?`, [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: '文章不存在' });
    const post = rows[0];
    // 未发布草稿只有站长本人（真实登录会话）能读：旧写法是"任何人在地址栏输入 slug 就能看到全文"，
    // 半成品、写给自己看的草稿会被路人 / 爬虫顺手读走甚至收录进搜索引擎。
    // 管理页的编辑与预览走同一个接口 + 登录 Cookie，站长自己的流程不受影响；只读访客会话不算本人。
    if (+post.published !== 1) {
      if (!isOwnerUser(req.user)) return res.status(404).json({ error: '文章不存在' }); // 与真不存在同响应，避免拿它探测 slug
      res.set('Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    post.html = sanitizeHtmlSafe(md.render(post.content || ''));
    post.tags = post.tags ? post.tags.split(',') : [];
    post.created_at = toIsoUtc(post.created_at);
    post.updated_at = toIsoUtc(post.updated_at);
    res.json(post);
  } catch (e) { next(e); }
});

// 标签列表
router.get('/tags', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.name, COUNT(pt.post_id) AS count FROM tags t
       JOIN post_tags pt ON pt.tag_id = t.id
       JOIN posts p ON p.id = pt.post_id AND p.published = 1
       GROUP BY t.id ORDER BY count DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

// ---------- 管理接口 ----------
router.use('/admin/posts', requireAdmin);

async function upsertTags(conn, postId, tags) {
  if (!Array.isArray(tags)) return;
  await conn.query('DELETE FROM post_tags WHERE post_id = ?', [postId]);
  for (const name of tags) {
    const nameStr = String(name).trim().slice(0, 64);
    if (!nameStr) continue;
    const [tagRows] = await conn.query('SELECT id FROM tags WHERE name = ?', [nameStr]);
    let tagId;
    if (tagRows.length) tagId = tagRows[0].id;
    else { const [ins] = await conn.query('INSERT INTO tags (name) VALUES (?)', [nameStr]); tagId = ins.insertId; }
    await conn.query('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)', [postId, tagId]);
  }
}

router.get('/admin/posts', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, slug, title, published, created_at, updated_at FROM posts ORDER BY created_at DESC, id DESC');
    res.json(rows.map(r => ({ ...r, created_at: toIsoUtc(r.created_at), updated_at: toIsoUtc(r.updated_at) })));
  } catch (e) { next(e); }
});

router.post('/admin/posts', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { title, summary, content, tags, published = 1 } = req.body || {};
    const slug = normSlug(req.body && req.body.slug);
    if (!title) return res.status(400).json({ error: '缺少 title/slug' });
    const badSlug = slugError(slug);
    if (badSlug) return res.status(400).json({ error: badSlug });
    await conn.beginTransaction();
    const [ins] = await conn.query(
      'INSERT INTO posts (slug, title, summary, content, published) VALUES (?, ?, ?, ?, ?)',
      [slug, String(title).trim(), summary || '', content || '', toPublished(published)]
    );
    await upsertTags(conn, ins.insertId, tags);
    await conn.commit();
    res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    await conn.rollback();
    if (/UNIQUE constraint/i.test(e.message || '')) return res.status(409).json({ error: 'slug 已存在' });
    next(e);
  } finally {
    conn.release();
  }
});

router.put('/admin/posts/:id', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id 无效' });
    const { title, summary, content, tags, published } = req.body || {};
    const slug = normSlug(req.body && req.body.slug);
    if (!title) return res.status(400).json({ error: '缺少 title/slug' });
    const badSlug = slugError(slug);
    if (badSlug) return res.status(400).json({ error: badSlug });
    await conn.beginTransaction();
    const [r] = await conn.query(
      'UPDATE posts SET slug = ?, title = ?, summary = ?, content = ?, published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [slug, String(title).trim(), summary || '', content || '', toPublished(published), id]
    );
    // 文章在另一个标签页被删掉时，旧编辑页再点保存不该回一个"已保存"却什么都没写进去
    if (!r.affectedRows) { await conn.rollback(); return res.status(404).json({ error: '文章不存在或已被删除' }); }
    if (Array.isArray(tags)) await upsertTags(conn, id, tags);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    if (/UNIQUE constraint/i.test(e.message || '')) return res.status(409).json({ error: 'slug 已存在' });
    next(e);
  } finally {
    conn.release();
  }
});

router.delete('/admin/posts/:id', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id 无效' });
    await conn.beginTransaction();
    await conn.query('DELETE FROM post_tags WHERE post_id = ?', [id]);
    const [r] = await conn.query('DELETE FROM posts WHERE id = ?', [id]);
    if (!r.affectedRows) { await conn.rollback(); return res.status(404).json({ error: '文章不存在或已被删除' }); }
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

module.exports = router;
module.exports.listWhere = listWhere;
