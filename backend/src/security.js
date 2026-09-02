
// security.js - 安全中间件：安全响应头 / CSP / Origin 校验（CSRF）/ 写接口限流
const config = require('./config');

// 请求来源 host（Origin 或 Referer 中解析）
function originOf(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return '';
  try { return new URL(origin).host; } catch (e) { return ''; }
}

function isLocalDev(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function isSameOrigin(req) {
  const o = originOf(req);
  if (!o) return true; // 无 Origin/Referer（curl/脚本等）放行
  const host = req.headers.host || '';
  if (o === host) return true;
  // 本地开发：Vite(5173) -> API(3000) 跨端口，视为同源放行
  try {
    const oh = new URL(o.startsWith('http') ? o : 'http://' + o).hostname;
    const hh = host.split(':')[0];
    if (isLocalDev(oh) && isLocalDev(hh)) return true;
  } catch (e) { /* ignore */ }
  // 允许 PUBLIC_BASE 配置的源（Nginx 反代 / HTTPS 前置场景）
  try {
    if (o === new URL(config.publicBase).host) return true;
  } catch (e) { /* ignore */ }
  return false;
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",   // naive-ui / Vue 需要内联样式
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; '));
  next();
}

// 跨站写请求防护：非 GET 且带跨站 Origin/Referer 一律 403
function originGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (isSameOrigin(req)) return next();
  return res.status(403).json({ error: '跨站请求已拒绝', status: 403 });
}

// 简易内存限流（按 IP + 规则名），用于登录/写接口等敏感路径
const buckets = new Map();
function rateLimit({ windowMs = 60 * 1000, max = 120, name = 'api' } = {}) {
  return (req, res, next) => {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    const arr = (buckets.get(ip) || []).filter(x => now - x.t < windowMs);
    if (arr.filter(x => x.k === name).length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试', status: 429 });
    }
    arr.push({ t: now, k: name });
    buckets.set(ip, arr);
    if (buckets.size > 20000) buckets.clear(); // 防内存无限增长
    next();
  };
}

module.exports = { securityHeaders, originGuard, rateLimit, isSameOrigin, originOf };
