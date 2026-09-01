// 每日自动备份 bangumi-blog.db（VACUUM INTO 保证 WAL 下完整），保留 7 天
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const src = '/www/wwwroot/bangumi-blog/backend/data/bangumi-blog.db';
const dir = '/www/backup/bangumi-blog';
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const dest = path.join(dir, 'bangumi-blog-' + stamp + '.db');
if (fs.existsSync(dest)) fs.unlinkSync(dest); // 同一天重复执行时先删旧文件（VACUUM INTO 不允许覆盖）
try {
  const db = new DatabaseSync(src, { readOnly: true });
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  db.close();
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.db')) continue;
    const m = f.match(/(\d{4}-\d{2}-\d{2})/);
    if (m && new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) fs.unlinkSync(path.join(dir, f));
  }
  console.log('[backup] ok ' + dest + ' ' + fs.statSync(dest).size + ' bytes');
} catch (e) {
  console.error('[backup] failed:', e.message);
  process.exit(1);
}
