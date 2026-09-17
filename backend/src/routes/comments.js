
// routes/comments.js - 博客评论：公开发表（需审核）+ 站长审核管理
const express = require('express');
const { pool } = require('../db');
const { requireOwner } = require('../auth');
const { clientIpOf } = require('../security');
const { parseId, cleanName } = require('../query');
const router = express.Router();

const MAX_LEN = 2000;

// 站长昵称/用户名：评论列表只显示昵称，冒名等于伪造"站长回复"，禁止其他用户使用
async function ownerNameSet() {
  try {
    const [rows] = await pool.query('SELECT username, nickname FROM users WHERE is_owner = 1');
    const set = new Set();
    for (const r of rows) {
      for (const v of [r.username, r.nickname]) if (v) set.add(String(v).trim().toLowerCase());
    }
    return set;
  } catch (e) { return new Set(); }
}

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
    const isRequestOwner = !!(req.user && +req.user.is_owner === 1 && req.user.kind !== 'viewer');
    // 昵称：登录用户一律用账号昵称，忽略请求里的 name（否则任何登录用户都能冒充别人）；
    // 匿名用户可用昵称，但清洗后不许与站长昵称/用户名重复
    let name = req.user
      ? cleanName(req.user.nickname || req.user.username)
      : cleanName(body.name);
    if (!name) name = '匿名';
    if (!isRequestOwner && name !== '匿名') {
      const banned = await ownerNameSet();
      if (banned.has(name.toLowerCase())) name = '匿名';
    }
    // parent_id：必须是正整数，且是同一篇文章下已通过的评论
    // 旧写法 Math.max(0, +body.parent_id || 0) 允许"回复其他文章的评论"或回复不存在的 id，
    // 评论树里就会挂出一批父节点永远不存在的孤儿节点
    let parentId = 0;
    const rawParent = String(body.parent_id == null ? '' : body.parent_id).trim();
    if (rawParent && rawParent !== '0') {
      parentId = parseId(rawParent);
      if (!parentId) return res.status(400).json({ error: '父评论 id 无效' });
      const [parents] = await pool.query(
        "SELECT id FROM comments WHERE id = ? AND post_id = ? AND status = 'approved'",
        [parentId, posts[0].id]
      );
      if (!parents.length) return res.status(400).json({ error: '父评论不存在或未通过审核' });
    }
    const status = isRequestOwner ? 'approved' : 'pending';
    const ip = clientIpOf(req) || '';
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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: '评论 id 无效' });
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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: '评论 id 无效' });
    await pool.query('DELETE FROM comments WHERE id = ?', [id]);
    await pool.query('DELETE FROM comments WHERE parent_id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
