// auth.js - 会话管理（DB token + httpOnly cookie）
const crypto = require('crypto');
const config = require('./config');
const { pool } = require('./db');

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// kind: 'user' 普通会话（含 Bangumi/本地账号）| 'viewer' 站长只读访客会话
async function createSession(userId, kind = 'user', ttlMs = config.sessionTtlMs) {
  const token = randomToken();
  const expiresAt = Date.now() + ttlMs;
  await pool.query('INSERT INTO sessions (token, user_id, kind, expires_at) VALUES (?, ?, ?, ?)', [token, userId, kind, expiresAt]);
  return { token, expiresAt };
}

async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = ?', [token]);
}
// 清理所有已过期会话（启动时 + 定时调用），防止 sessions 表无限膨胀；返回删除的行数
async function cleanupExpiredSessions(now = Date.now()) {
  const [r] = await pool.query('DELETE FROM sessions WHERE expires_at <= ?', [now]);
  return (r && r.affectedRows) || 0;
}

// 返回用户行，并附带 session_kind（'user' | 'viewer'）
async function getUserBySession(token) {
  if (!token) return null;
  const [rows] = await pool.query(
    `SELECT u.*, s.kind AS session_kind FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
    [token, Date.now()]
  );
  if (!rows.length) return null;
  const u = rows[0];
  u.kind = u.session_kind || 'user';
  return u;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}

// 访客（只读）会话禁止任何写操作
function requireNotViewer(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.kind === 'viewer') return res.status(403).json({ error: '只读访客模式，不能修改数据' });
  next();
}

// 仅站长本人（is_owner = 1，且非只读访客会话）
function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.kind === 'viewer') return res.status(403).json({ error: '只读访客模式，不能修改数据' });
  if (+req.user.is_owner !== 1) return res.status(403).json({ error: '只有站长可以执行此操作' });
  next();
}

// 博客写作/上传等管理操作：改为仅站长本人
function requireAdmin(req, res, next) {
  return requireOwner(req, res, next);
}

module.exports = { createSession, deleteSession, cleanupExpiredSessions, getUserBySession, requireAuth, requireAdmin, requireOwner, requireNotViewer, randomToken };
