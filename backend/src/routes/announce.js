// routes/announce.js - 全站公告（动态：站长后台可编辑，访客首次弹窗 + 公告中心）
const express = require('express');
const { pool } = require('../db');
const { requireOwner } = require('../auth');
const router = express.Router();

// 最新一条已发布公告（首页弹窗用）
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, content, published, created_at, updated_at FROM announcements WHERE published = 1 ORDER BY id DESC LIMIT 1'
    );
    res.json(rows.length ? rows[0] : null);
  } catch (e) { next(e); }
});

// 全部已发布公告（公告中心页）
router.get('/list', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, content, published, created_at, updated_at FROM announcements WHERE published = 1 ORDER BY id DESC'
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// ---------- 管理接口（仅站长本人） ----------
router.get('/admin/list', requireOwner, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, content, published, created_at, updated_at FROM announcements ORDER BY id DESC'
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post('/', requireOwner, async (req, res, next) => {
  try {
    const { title, content = '', published = 1 } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: '缺少标题' });
    const [ins] = await pool.query(
      'INSERT INTO announcements (title, content, published) VALUES (?, ?, ?)',
      [String(title).trim(), String(content), published ? 1 : 0]
    );
    res.json({ ok: true, id: ins.insertId });
  } catch (e) { next(e); }
});

router.put('/:id', requireOwner, async (req, res, next) => {
  try {
    const id = +req.params.id;
    const { title, content, published } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: '缺少标题' });
    await pool.query(
      'UPDATE announcements SET title = ?, content = ?, published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [String(title).trim(), String(content || ''), published ? 1 : 0, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', requireOwner, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM announcements WHERE id = ?', [+req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

