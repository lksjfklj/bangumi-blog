// routes/upload.js - 博客图片上传（需管理令牌）
// 安全：MIME 白名单 + 文件魔数（文件头）双重校验，拒绝 SVG（防 XSS）与伪装图片
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

// 文件头魔数校验：防止「改后缀的 HTML/SVG/可执行文件」伪装成图片上传
function sniffImage(buf) {
  if (!buf || buf.length < 12) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // GIF: GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { data, mime } = req.body || {};
    if (!data || typeof data !== 'string') return res.status(400).json({ error: '缺少图片数据' });
    if (!MIME_EXT[mime]) return res.status(400).json({ error: '不支持的图片格式（仅 png/jpeg/webp/gif）' });
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) return res.status(400).json({ error: '图片内容为空' });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: '图片过大（最大 4MB）' });
    if (!sniffImage(buf)) return res.status(400).json({ error: '文件内容与图片格式不符，已拒绝' });
    const ext = MIME_EXT[mime];
    fs.mkdirSync(uploadDir, { recursive: true });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(uploadDir, name), buf);
    res.json({ ok: true, url: '/api/uploads/' + name });
  } catch (e) { next(e); }
});

module.exports = router;
