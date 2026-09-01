// imgutil.js - 封面图缩略（可选 sharp；未安装或解码失败时原样返回，不阻塞抓取）
let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const MAX_COVER_WIDTH = 640; // 列表卡片 128-300px，640 足够 2x 屏，还省一半流量

// 统一缩略：优先转 JPEG q80（体积最小），透明 PNG 保留 PNG，GIF 不动
// 返回 { buf, ext }；原图已足够小 / 处理失败时返回原 buffer
async function shrinkCover(buf, ext, maxW = MAX_COVER_WIDTH) {
  if (!sharp || !buf || !buf.length || ext === '.gif') return { buf, ext };
  try {
    const img = sharp(buf, { failOn: 'none', animated: false });
    const meta = await img.metadata().catch(() => null);
    const isPng = ext === '.png' || (meta && meta.format === 'png');
    const hasAlpha = meta ? !!meta.hasAlpha : false;
    const resize = (p) => p.rotate().resize({ width: maxW, withoutEnlargement: true });
    let out, newExt;
    if (isPng && hasAlpha) {
      out = await resize(img.clone()).png({ compressionLevel: 9 }).toBuffer();
      newExt = '.png';
    } else {
      out = await resize(img.clone()).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      newExt = '.jpg';
    }
    if (!out || !out.length) return { buf, ext };
    // 转换后没变小（极小图/已压缩图）就保持原样，避免无谓重编码
    return out.length < buf.length ? { buf: out, ext: newExt } : { buf, ext };
  } catch (e) {
    return { buf, ext };
  }
}

module.exports = { shrinkCover, MAX_COVER_WIDTH };
