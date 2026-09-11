// admin.js - 站长专属的站点总览（注册用户清单等）
// 全部接口仅站长本人可用：requireOwner 会同时挡掉只读访客（viewer）会话。
const express = require('express');
const { pool } = require('../db');
const { requireOwner } = require('../auth');

const router = express.Router();

// SQLite 的 CURRENT_TIMESTAMP 存的是 UTC 文本（YYYY-MM-DD HH:MM:SS）。
// 直接丢给浏览器 new Date() 会被当成本地时间解析，导致比真实时间早 8 小时，
// 这里统一补成带 Z 的 ISO 字符串，让前端按本地时区正确显示。
function toIsoUtc(s) {
  if (!s) return null;
  const t = String(s);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return t.replace(' ', 'T') + 'Z';
  return t;
}

// 邮箱脱敏：lvger@qq.com -> lv***@qq.com（前端可切换显示完整邮箱）
function maskEmail(e) {
  const s = String(e || '').trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at <= 0) return s.length > 2 ? s.slice(0, 2) + '***' : s[0] + '***';
  const name = s.slice(0, at);
  const domain = s.slice(at);
  if (name.length <= 1) return name + '***' + domain;
  if (name.length === 2) return name[0] + '***' + domain;
  return name.slice(0, 2) + '***' + domain;
}

// GET /api/admin/users —— 注册人数计数 + 用户清单（仅站长）
router.get('/users', requireOwner, async (req, res, next) => {
  try {
    const [aggRows] = await pool.query(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_owner = 1 THEN 1 ELSE 0 END) AS owners,
        SUM(CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END) AS local_accounts,
        SUM(CASE WHEN bangumi_uid IS NOT NULL THEN 1 ELSE 0 END) AS bangumi_accounts,
        SUM(CASE WHEN email IS NOT NULL AND email <> '' THEN 1 ELSE 0 END) AS with_email,
        SUM(CASE WHEN email_verified_at > 0 THEN 1 ELSE 0 END) AS email_verified,
        SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS new_1d,
        SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS new_7d,
        SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS new_30d
      FROM users`);
    const agg = aggRows[0] || {};

    // 近 7 天登录过的账号数（登录即写一条 session，作为活跃度代理指标）
    const [actRows] = await pool.query(
      `SELECT COUNT(DISTINCT user_id) AS n FROM sessions
        WHERE kind = 'user' AND created_at >= datetime('now', '-7 days')`
    );
    // 当前有效的只读访客会话数（同学那种「站长视角」浏览）
    const [viewerRows] = await pool.query(
      `SELECT COUNT(*) AS n FROM sessions WHERE kind = 'viewer' AND expires_at > ?`,
      [Date.now()]
    );

    const [rows] = await pool.query(`SELECT
        u.id, u.bangumi_uid, u.username, u.nickname, u.avatar, u.email, u.email_verified_at,
        u.is_owner, u.profile_public, u.created_at, u.last_collection_sync_at,
        (u.password_hash IS NOT NULL) AS has_password,
        (SELECT COUNT(*) FROM collections c WHERE c.user_id = u.id) AS collections,
        (SELECT COUNT(*) FROM comments cm WHERE cm.user_id = u.id) AS comments,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.kind = 'user' AND s.expires_at > ?) AS live_sessions,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id AND s.kind = 'user') AS last_login_at,
        (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_session_at
      FROM users u
      ORDER BY u.id`, [Date.now()]);

    const num = (v) => (+v || 0);
    const users = rows.map((u) => {
      const hasPw = +u.has_password === 1;
      return {
        id: u.id,
        nickname: u.nickname || u.username || ('用户 #' + u.id),
        username: u.username || '',
        avatar: u.avatar || '',
        bangumi_uid: u.bangumi_uid || null,
        email: u.email || '',
        email_masked: maskEmail(u.email),
        email_verified: num(u.email_verified_at) > 0,
        is_owner: +u.is_owner === 1,
        profile_public: +u.profile_public === 1,
        // 本地注册（邮箱+密码）/ Bangumi 授权登录
        source: hasPw ? 'local' : (u.bangumi_uid ? 'bangumi' : 'unknown'),
        created_at: toIsoUtc(u.created_at),
        last_login_at: toIsoUtc(u.last_login_at || u.last_session_at),
        last_sync_at: u.last_collection_sync_at ? new Date(+u.last_collection_sync_at).toISOString() : null,
        collections: num(u.collections),
        comments: num(u.comments),
        live_sessions: num(u.live_sessions)
      };
    });

    res.json({
      stats: {
        total: num(agg.total),
        owners: num(agg.owners),
        local_accounts: num(agg.local_accounts),
        bangumi_accounts: num(agg.bangumi_accounts),
        with_email: num(agg.with_email),
        email_verified: num(agg.email_verified),
        new_1d: num(agg.new_1d),
        new_7d: num(agg.new_7d),
        new_30d: num(agg.new_30d),
        active_7d: num(actRows[0] && actRows[0].n),
        viewer_sessions: num(viewerRows[0] && viewerRows[0].n)
      },
      users
    });
  } catch (e) { next(e); }
});

module.exports = router;
