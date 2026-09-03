// routes/img.js - 图片代理缓存（lain.bgm.tv 国内不可直连）
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetch, ProxyAgent } = require('undici');
const config = require('../config');
const router = express.Router();

let dispatcher = null;
if (config.bangumi.proxy) dispatcher = new ProxyAgent(config.bangumi.proxy);

const ALLOWED_HOSTS = /(^|\.)(bgm\.tv|lain\.bgm\.tv|t\.vndb\.org|s\.vndb\.org)$/i;

router.get('/', async (req, res) => {
  const u = req.query.u || req.query.url || '';
  let url;
  try { url = new URL(String(u)); } catch (e) { return res.status(400).send('bad url'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return res.status(400).send('bad protocol');
  if (!ALLOWED_HOSTS.test(url.hostname)) return res.status(403).send('host not allowed');

  fs.mkdirSync(config.imgCacheDir, { recursive: true });
  const key = crypto.createHash('md5').update(url.href).digest('hex');
  const file = path.join(config.imgCacheDir, key + path.extname(url.pathname) || '.bin');
  const cacheHits = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 30 * 24 * 3600 * 1000;
  if (cacheHits) {
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Img-Cache', 'HIT');
    return res.sendFile(file);
  }

  try {
    const upstream = await fetch(url.href, { dispatcher, signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return res.status(502).send('upstream ' + upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    fs.writeFile(file, buf, () => {});
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Img-Cache', 'MISS');
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.send(buf);
  } catch (e) {
    // 代理不可用时尽量返回本地缓存
    if (fs.existsSync(file)) return res.sendFile(file);
    res.status(502).send('image proxy unavailable');
  }
});

module.exports = router;
