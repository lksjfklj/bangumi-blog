// routes/auth.js - 登录体系：Bangumi OAuth / 本地账号注册登录 / 站长只读访客模式
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { pool } = require('../db');
const { oauthAuthorizeUrl, oauthExchange, bgm, getValidToken } = require('../bangumi');
const { createSession, deleteSession, getUserBySession } = require('../auth');
const router = express.Router();

// ---------- 密码哈希（scrypt，随机盐） ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return 'scrypt$' + salt + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || !String(stored).startsWith('scrypt$')) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  const a = Buffer.from(hash.toString('hex'), 'hex');
  const b = Buffer.from(parts[2], 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setSid(res, token) {
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: config.sessionTtlMs });
}

// 是否站长（Bangumi UID 匹配或已标记 is_owner）
function isOwnerUser(row) {
  return +row.is_owner === 1 || (config.ownerBangumiUid > 0 && +row.bangumi_uid === config.ownerBangumiUid);
}

async function markOwner(row) {
  if (isOwnerUser(row)) {
    try { await pool.query('UPDATE users SET is_owner = 1 WHERE id = ?', [row.id]); } catch (e) { /* ignore */ }
  }
}

// ---------- Bangumi OAuth ----------
// 发起登录：跳转 bgm.tv OAuth
router.get('/bangumi', (req, res) => {
  if (!config.bangumi.clientId) {
    return res.status(503).json({ error: '尚未配置 Bangumi OAuth 应用（CLIENT_ID）' });
  }
  const state = crypto.randomBytes(8).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(oauthAuthorizeUrl(state));
});

// OAuth 回调
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/login?login_error=' + encodeURIComponent(error));
    if (state && req.cookies.oauth_state && state !== req.cookies.oauth_state) {
      return res.redirect('/login?login_error=state_mismatch');
    }
    if (!code) return res.status(400).json({ error: '缺少 code' });
    const data = await oauthExchange(code);
    if (!data || !data.access_token) {
      return res.redirect('/login?login_error=token_failed');
    }
    const me = await bgm('/v0/me', { token: data.access_token });
    const uid = me.id;
    const nickname = me.nickname || me.username || 'Bangumi 用户';
    const avatar = (me.avatar && me.avatar.large) || '';
    const expiresAt = Date.now() + (data.expires_in || 604800) * 1000;

    const [existing] = await pool.query('SELECT * FROM users WHERE bangumi_uid = ?', [uid]);
    let userId;
    if (existing.length) {
      userId = existing[0].id;
      await pool.query(
        'UPDATE users SET nickname = ?, avatar = ?, access_token = ?, refresh_token = ?, token_expires_at = ?, is_owner = ? WHERE id = ?',
        [nickname, avatar, data.access_token, data.refresh_token || existing[0].refresh_token, expiresAt, isOwnerUser(existing[0]) ? 1 : 0, userId]
      );
    } else {
      const [ins] = await pool.query(
        'INSERT INTO users (bangumi_uid, username, nickname, avatar, access_token, refresh_token, token_expires_at, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uid, me.username || '', nickname, avatar, data.access_token, data.refresh_token || '', expiresAt, config.ownerBangumiUid === uid ? 1 : 0]
      );
      userId = ins.insertId;
    }
    const { token } = await createSession(userId, 'user');
    res.clearCookie('oauth_state');
    setSid(res, token);
    res.redirect('/collection?login=1');
  } catch (e) { next(e); }
});


// ---------- 简单内存限流（按 IP，防爆破） ----------
const rateBuckets = new Map(); // ip -> [{ t, kind }]
function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function checkRate(req, kind, limit, windowMs) {
  const ip = clientIp(req);
  const now = Date.now();
  const arr = (rateBuckets.get(ip) || []).filter(x => now - x.t < windowMs);
  const mine = arr.filter(x => x.kind === kind);
  if (mine.length >= limit) return false;
  arr.push({ t: now, kind });
  rateBuckets.set(ip, arr);
  if (rateBuckets.size > 10000) rateBuckets.clear(); // 防内存无限增长
  return true;
}

// ---------- 本地账号 ----------
// 注册
router.post('/register', async (req, res, next) => {
  try {
    if (!checkRate(req, 'register', 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
    }
    const { username, password, nickname } = req.body || {};
    const name = String(username || '').trim();
    const pwd = String(password || '');
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,24}$/.test(name)) {
      return res.status(400).json({ error: '用户名需为 2-24 位字母/数字/下划线/中文' });
    }
    if (pwd.length < 6 || pwd.length > 72) {
      return res.status(400).json({ error: '密码长度需为 6-72 位' });
    }
    const [dup] = await pool.query('SELECT id FROM users WHERE username = ? AND password_hash IS NOT NULL', [name]);
    if (dup.length) return res.status(409).json({ error: '用户名已被占用' });
    const [ins] = await pool.query(
      'INSERT INTO users (username, nickname, password_hash, is_owner) VALUES (?, ?, ?, 0)',
      [name, String(nickname || '').trim().slice(0, 32) || name, hashPassword(pwd)]
    );
    const { token } = await createSession(ins.insertId, 'user');
    setSid(res, token);
    res.json({ ok: true, user: { id: ins.insertId, username: name, nickname: nickname || name, role: 'user' } });
  } catch (e) { next(e); }
});

// 登录
router.post('/login', async (req, res, next) => {
  try {
    if (!checkRate(req, 'login', 10, 60 * 1000)) {
      return res.status(429).json({ error: '尝试过于频繁，请 1 分钟后再试' });
    }
    const { username, password } = req.body || {};
    const name = String(username || '').trim();
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND password_hash IS NOT NULL', [name]);
    if (!rows.length || !verifyPassword(String(password || ''), rows[0].password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const user = rows[0];
    await markOwner(user);
    const { token } = await createSession(user.id, 'user');
    setSid(res, token);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 站长只读访客模式 ----------
// 不登录，以站长身份进入只读浏览（写接口一律 403）
router.post('/viewer', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1');
    if (!rows.length) return res.status(400).json({ error: '尚未初始化站长账号' });
    const owner = rows[0];
    const { token } = await createSession(owner.id, 'viewer');
    setSid(res, token);
    res.json({ ok: true, viewer: true, user: {
      id: owner.id,
      bangumi_uid: owner.bangumi_uid,
      nickname: owner.nickname,
      avatar: owner.avatar,
      role: 'viewer'
    } });
  } catch (e) { next(e); }
});

// ---------- 当前用户 ----------
router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null, viewer: false });
  const token = await getValidToken(req.user);
  const isOwner = +req.user.is_owner === 1;
  const viewer = req.user.kind === 'viewer';
  const role = viewer ? 'viewer' : (isOwner ? 'owner' : 'user');
  res.json({ user: {
    id: req.user.id,
    bangumi_uid: req.user.bangumi_uid,
    username: req.user.username,
    nickname: req.user.nickname,
    avatar: req.user.avatar,
    connected: !!token,
    is_owner: isOwner,
    role
  }, viewer });
});

// 登出
router.post('/logout', async (req, res, next) => {
  try {
    if (req.cookies.sid) await deleteSession(req.cookies.sid);
    res.clearCookie('sid');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
