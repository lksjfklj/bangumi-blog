// bangumi.js - Bangumi API 客户端（支持代理出口 + 数据库缓存兜底）
const { fetch, ProxyAgent } = require('undici');
const config = require('./config');
const { pool } = require('./db');

const API_BASE = 'https://api.bgm.tv';
const WEB_BASE = 'https://bgm.tv';

let dispatcher = null;
if (config.bangumi.proxy) {
  dispatcher = new ProxyAgent(config.bangumi.proxy);
}

class BgmError extends Error {
  constructor(status, body) {
    super('Bangumi API error: ' + status);
    this.status = status;
    this.body = body;
  }
}

async function rawRequest(url, { method = 'GET', headers = {}, body, token } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': config.bangumi.userAgent,
      Accept: 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    dispatcher,
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch (e) { /* ignore */ }
    const err = new BgmError(res.status, errBody);
    throw err;
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text; }
}

async function bgm(path, opts = {}) {
  const url = /^https?:\/\//.test(path) ? path : API_BASE + path;
  return rawRequest(url, opts);
}

async function bgmWeb(path, opts = {}) {
  const url = /^https?:\/\//.test(path) ? path : WEB_BASE + path;
  return rawRequest(url, opts);
}

// 带缓存的请求：先查缓存，miss 或过期则请求并回填；请求失败时返回过期缓存兜底
async function cached(key, ttlMs, fn) {
  const now = Date.now();
  try {
    const [rows] = await pool.query('SELECT value, expires_at FROM cache WHERE cache_key = ?', [key]);
    if (rows.length && rows[0].expires_at > now) {
      return JSON.parse(rows[0].value);
    }
  } catch (e) { /* cache read fail -> ignore */ }

  try {
    const data = await fn();
    try {
      await pool.query(
        'INSERT INTO cache (cache_key, value, expires_at) VALUES (?, ?, ?)' + ' ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
        [key, JSON.stringify(data), now + ttlMs]
      );
    } catch (e) { /* cache write fail -> ignore */ }
    return data;
  } catch (err) {
    // 请求失败：尝试返回过期缓存
    try {
      const [rows] = await pool.query('SELECT value, expires_at FROM cache WHERE cache_key = ?', [key]);
      if (rows.length) return JSON.parse(rows[0].value);
    } catch (e) { /* ignore */ }
    throw err;
  }
}

// ---------- OAuth ----------
function oauthAuthorizeUrl(state) {
  const q = new URLSearchParams({
    client_id: config.bangumi.clientId,
    response_type: 'code',
    redirect_uri: config.bangumi.redirectUri,
    state: state || ''
  });
  return WEB_BASE + '/oauth/authorize?' + q.toString();
}

async function oauthExchange(code) {
  return rawRequest(WEB_BASE + '/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      grant_type: 'authorization_code',
      client_id: config.bangumi.clientId,
      client_secret: config.bangumi.clientSecret,
      code,
      redirect_uri: config.bangumi.redirectUri
    }
  });
}

async function oauthRefresh(refreshToken) {
  return rawRequest(WEB_BASE + '/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      grant_type: 'refresh_token',
      client_id: config.bangumi.clientId,
      client_secret: config.bangumi.clientSecret,
      refresh_token: refreshToken
    }
  });
}

// 获取有效 access_token（自动刷新并更新数据库）
async function getValidToken(user) {
  if (!user) return null;
  const now = Date.now();
  if (user.access_token && user.token_expires_at > now + 60 * 1000) return user.access_token;
  if (!user.refresh_token) return null;
  try {
    const data = await oauthRefresh(user.refresh_token);
    if (data && data.access_token) {
      await pool.query(
        'UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?',
        [data.access_token, data.refresh_token || user.refresh_token, now + (data.expires_in || 604800) * 1000, user.id]
      );
      user.access_token = data.access_token;
      user.refresh_token = data.refresh_token || user.refresh_token;
      user.token_expires_at = now + (data.expires_in || 604800) * 1000;
      return data.access_token;
    }
  } catch (e) { /* refresh failed */ }
  return null;
}

module.exports = { bgm, bgmWeb, cached, oauthAuthorizeUrl, oauthExchange, oauthRefresh, getValidToken, BgmError };
