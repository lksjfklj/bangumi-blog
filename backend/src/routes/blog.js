// routes/blog.js - 个人博客：文章/标签/管理
const express = require('express');
const md = require('markdown-it')({ html: true, linkify: true, breaks: false });
const { sanitizeHtmlSafe } = require('../sanitize');
const { pool } = require('../db');
const { requireAdmin } = require('../auth');
const router = express.Router();

// 文章列表（公开：仅已发布）
router.get('/posts', async (req, res, next) => {
  try {
    const { tag, q, page = 1, size = 10 } = req.query;
    const limit = Math.min(+size || 10, 50);
    const offset = (Math.max(+page || 1, 1) - 1) * limit;
    let sql = `SELECT p.id, p.slug, p.title, p.summary, p.published, p.created_at, p.updated_at,
               (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tags
               FROM posts p WHERE p.published = 1`;
    const args = [];
    if (tag) { sql += ' AND p.id IN (SELECT post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)'; args.push(tag); }
    if (q) { sql += ' AND (p.title LIKE ? OR p.summary LIKE ? OR p.content LIKE ?)'; const like = '%' + q + '%'; args.push(like, like, like); }
    sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);
    const [rows] = await pool.query(sql, args);
    const [cnt] = await pool.query(
      'SELECT COUNT(*) AS total FROM posts p WHERE p.published = 1' + (tag ? ' AND p.id IN (SELECT post_id FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ?)' : ''),
      tag ? [tag] : []
    );
    const list = rows.map(r => ({ ...r, tags: r.tags ? r.tags.split(',') : [] }));
    res.json({ data: list, total: cnt[0].total, page: +page, size: limit });
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
    // 按用户要求：草稿也可直接通过 slug 预览（已移除管理令牌限制）
    post.html = sanitizeHtmlSafe(md.render(post.content || ''));
    post.tags = post.tags ? post.tags.split(',') : [];
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
    const [rows] = await pool.query('SELECT id, slug, title, published, created_at, updated_at FROM posts ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/admin/posts', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { slug, title, summary, content, tags, published = 1 } = req.body || {};
    if (!title || !slug) return res.status(400).json({ error: '缺少 title/slug' });
    await conn.beginTransaction();
    const [ins] = await conn.query(
      'INSERT INTO posts (slug, title, summary, content, published) VALUES (?, ?, ?, ?, ?)',
      [String(slug).trim(), String(title).trim(), summary || '', content || '', published ? 1 : 0]
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
    const { slug, title, summary, content, tags, published } = req.body || {};
    const id = +req.params.id;
    await conn.beginTransaction();
    await conn.query(
      'UPDATE posts SET slug = ?, title = ?, summary = ?, content = ?, published = ? WHERE id = ?',
      [slug || '', title || '', summary || '', content || '', published ? 1 : 0, id]
    );
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
    await conn.beginTransaction();
    await conn.query('DELETE FROM post_tags WHERE post_id = ?', [+req.params.id]);
    await conn.query('DELETE FROM posts WHERE id = ?', [+req.params.id]);
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
