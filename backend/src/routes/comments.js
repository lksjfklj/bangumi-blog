
// routes/comments.js - 博客评论：公开发表（需审核）+ 站长审核管理
const express = require('express');
const { pool } = require('../db');
const { requireOwner } = require('../auth');
const router = express.Router();

const MAX_LEN = 2000;

// 递归组装评论树
function treeOf(rows) {
  const byId = new Map();
  const roots = [];
  for (const r of rows) { r.children = []; byId.set(r.id, r); }
  for (const r of rows) {
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).children.push(r);
    else roots.push(r);
  }
  return roots;
}

// 公开：某篇文章的已通过评论
// GET /api/blog/posts/:slug/comments
router.get('/posts/:slug/comments', async (req, res, next) => {
  try {
    const [posts] = await pool.query('SELECT id FROM posts WHERE slug = ?', [String(req.params.slug).slice(0, 200)]);
    if (!posts.length) return res.status(404).json({ error: '文章不存在' });
    const [rows] = await pool.query(
      "SELECT id, parent_id, name, content, created_at FROM comments WHERE post_id = ? AND status = 'approved' ORDER BY id ASC",
      [posts[0].id]
    );
    res.set('Cache-Control', 'public, max-age=120, s-maxage=120');
    res.json({ data: treeOf(rows) });
  } catch (e) { next(e); }
});

// 公开：发表评论（站长本人直接通过，其余进入待审）
// POST /api/blog/posts/:slug/comments  { name?, content, parent_id? }
router.post('/posts/:slug/comments', async (req, res, next) => {
  try {
    const [posts] = await pool.query('SELECT id FROM posts WHERE slug = ? AND published = 1', [String(req.params.slug).slice(0, 200)]);
    if (!posts.length) return res.status(404).json({ error: '文章不存在或未发布' });
    const body = req.body || {};
    const content = String(body.content || '').trim().slice(0, MAX_LEN);
    if (!content) return res.status(400).json({ error: '评论内容不能为空' });
    let name = String(body.name || '').trim().slice(0, 40);
    if (req.user) name = name || req.user.nickname || req.user.username || '匿名';
    if (!name) name = '匿名';
    const parentId = Math.max(0, +body.parent_id || 0);
    const isOwner = !!(req.user && +req.user.is_owner === 1 && req.user.kind !== 'viewer');
    const status = isOwner ? 'approved' : 'pending';
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || (req.socket && req.socket.remoteAddress) || '';
    await pool.query(
      'INSERT INTO comments (post_id, parent_id, user_id, name, content, status, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [posts[0].id, parentId, req.user ? req.user.id : null, name, content, status, ip.slice(0, 45)]
    );
    res.status(201).json({ ok: true, status });
  } catch (e) { next(e); }
});

// 站长：评论列表（可按状态过滤）
// GET /api/blog/comments?status=pending|approved|spam|all
router.get('/comments', requireOwner, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending').slice(0, 20);
    let where = '';
    const args = [];
    if (status !== 'all') { where = ' WHERE status = ?'; args.push(status); }
    const [rows] = await pool.query(
      'SELECT c.*, p.slug, p.title AS post_title FROM comments c LEFT JOIN posts p ON p.id = c.post_id' + where + ' ORDER BY c.id DESC LIMIT 300',
      args
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// 站长：审核评论（通过/标记垃圾）
// PUT /api/blog/comments/:id  { status: 'approved' | 'spam' | 'pending' }
router.put('/comments/:id', requireOwner, async (req, res, next) => {
  try {
    const id = +req.params.id;
    const status = String((req.body || {}).status || '').slice(0, 20);
    if (!['approved', 'spam', 'pending'].includes(status)) return res.status(400).json({ error: '状态无效' });
    await pool.query('UPDATE comments SET status = ? WHERE id = ?', [status, id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 站长：删除评论
// DELETE /api/blog/comments/:id
router.delete('/comments/:id', requireOwner, async (req, res, next) => {
  try {
    const id = +req.params.id;
    await pool.query('DELETE FROM comments WHERE id = ?', [id]);
    await pool.query('DELETE FROM comments WHERE parent_id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
