// routes/upload.js - 博客图片上传（需管理令牌）
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requireAdmin } = require('../auth');
const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', 'uploads');
const MAX_BYTES = 4 * 1024 * 1024; // 原图最大 4MB
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { data, mime } = req.body || {};
    if (!data || typeof data !== 'string') return res.status(400).json({ error: '缺少图片数据' });
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) return res.status(400).json({ error: '图片内容为空' });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: '图片过大（最大 4MB）' });
    const ext = MIME_EXT[mime] || '.png';
    fs.mkdirSync(uploadDir, { recursive: true });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(uploadDir, name), buf);
    res.json({ ok: true, url: '/api/uploads/' + name });
  } catch (e) { next(e); }
});

module.exports = router;
