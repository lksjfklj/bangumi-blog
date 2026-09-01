// resize-cache.cjs - 一次性迁移：把 news-img 缓存里的大图统一缩到 640px，
// 并把 news / anime_episodes 表里的 /api/newsimg/<key>.<oldext> 更新为 <key>.jpg
// 用法: node scripts/resize-cache.cjs [--db 路径]
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { shrinkCover } = require('../src/imgutil');

const root = path.resolve(__dirname, '..');
const imgDir = path.join(root, 'news-img');
const dbArg = process.argv.find(a => a.startsWith('--db='));
const dbFile = dbArg ? dbArg.slice(5) : path.join(root, 'data', 'bangumi-blog.db');

if (!fs.existsSync(imgDir)) { console.log('[resize-cache] no news-img dir, nothing to do'); process.exit(0); }
if (!fs.existsSync(dbFile)) { console.log('[resize-cache] db not found:', dbFile); process.exit(1); }

(async () => {
  const files = fs.readdirSync(imgDir).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f));
  let converted = 0, skipped = 0, failed = 0, savedBytes = 0;
  const urlUpdates = []; // { oldPath, newPath }
  for (const f of files) {
    const abs = path.join(imgDir, f);
    let st;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    const ext = path.extname(f).toLowerCase();
    if (ext === '.gif' || st.size < 60 * 1024) { skipped++; continue; } // gif 或小于 60KB 不动
    try {
      const buf = fs.readFileSync(abs);
      const out = await shrinkCover(buf, ext);
      if (out.ext === ext && out.buf.length >= buf.length) { skipped++; continue; }
      const key = f.slice(0, -ext.length);
      const newFile = key + out.ext;
      fs.writeFileSync(path.join(imgDir, newFile), out.buf);
      if (newFile !== f) fs.rmSync(abs, { force: true });
      savedBytes += buf.length - out.buf.length;
      urlUpdates.push({ old: '/api/newsimg/' + f, neu: '/api/newsimg/' + newFile });
      converted++;
    } catch (e) {
      failed++;
      console.log('[resize-cache] fail', f, e.message);
    }
  }

  // 更新 DB 里的封面 URL
  let updatedRows = 0;
  if (urlUpdates.length) {
    const db = new DatabaseSync(dbFile);
    for (const u of urlUpdates) {
      for (const tbl of ['news', 'anime_episodes']) {
        try {
          const r = db.prepare('UPDATE ' + tbl + ' SET cover = ? WHERE cover = ?').run(u.neu, u.old);
          updatedRows += Number(r.changes || 0);
        } catch (e) { /* 表可能不存在 */ }
      }
    }
    db.close();
  }
  console.log(`[resize-cache] done: converted=${converted} skipped=${skipped} failed=${failed} saved=${(savedBytes/1048576).toFixed(1)}MB dbRows=${updatedRows}`);
})();
