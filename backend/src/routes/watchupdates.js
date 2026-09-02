
// routes/watchupdates.js - 追番新话更新·未读/已读（updatepusher 落库后供前端角标与列表使用）
const express = require('express');
const { pool } = require('../db');
const router = express.Router();

// 未读列表：GET /api/watch/updates/unread?limit=100
router.get('/updates/unread', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: '请先登录', status: 401 });
    const limit = Math.min(Math.max(+req.query.limit || 100, 1), 200);
    const [rows] = await pool.query(
      "SELECT wu.id, wu.subject_id, wu.series_title, wu.name_cn, wu.name, wu.episode, wu.sub_group, " +
      "wu.quality, wu.magnet, wu.link, wu.published_at, wu.read, wu.created_at, COALESCE(c.image, '') AS image " +
      "FROM watch_updates wu LEFT JOIN collections c ON c.user_id = wu.user_id AND c.subject_id = wu.subject_id " +
      "WHERE wu.user_id = ? ORDER BY wu.id DESC LIMIT ?",
      [req.user.id, limit]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ unread: rows.filter(r => !r.read).length, total: rows.length, data: rows });
  } catch (e) { next(e); }
});

// 标记已读：POST /api/watch/updates/read  { ids?: number[] }（不传则全部已读）
router.post('/updates/read', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: '请先登录', status: 401 });
    const ids = Array.isArray((req.body || {}).ids)
      ? req.body.ids.map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 500)
      : [];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      await pool.query('UPDATE watch_updates SET read = 1 WHERE user_id = ? AND id IN (' + ph + ')', [req.user.id, ...ids]);
    } else {
      await pool.query('UPDATE watch_updates SET read = 1 WHERE user_id = ? AND read = 0', [req.user.id]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
