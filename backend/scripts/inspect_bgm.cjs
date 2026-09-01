const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2] || '/www/wwwroot/bangumi-blog/backend/data/bangumi-blog.db');
const rows = db.prepare(`SELECT series_key, series_title, COUNT(*) n, COUNT(bgm_subject_id) matched
  FROM anime_episodes WHERE series_key != '' GROUP BY series_key ORDER BY n DESC`).all();
console.log('distinct series:', rows.length);
console.log('matched series:', rows.filter(r=>r.matched>0).length);
console.log('unmatched series:', rows.filter(r=>r.matched===0).length);
console.log('--- top 80 unmatched by count ---');
for (const r of rows.filter(r=>r.matched===0).slice(0,80)) console.log(r.n, '|', r.series_title, '|', r.series_key);
