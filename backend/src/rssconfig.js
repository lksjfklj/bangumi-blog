// rssconfig.js - RSS 源与关键词过滤的可配置存储（DB settings 表，admin 可改）
// watch/news 模块启动时读取，缺省回退到代码内置默认值；运行中每次抓取前重新读取，支持后台热更新。
const { pool } = require('./db');

// settings 表（key-value）
async function ensureSettingsTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
}
ensureSettingsTable().catch(() => {});

// 读一个 JSON 配置，缺省返回 fallback（不存在或解析失败）
async function getSetting(key, fallback) {
  try {
    const [rows] = await pool.query('SELECT value FROM settings WHERE key = ?', [key]);
    if (rows.length && rows[0].value) {
      const v = JSON.parse(rows[0].value);
      return v;
    }
  } catch (e) { /* 解析失败/表不存在 -> fallback */ }
  return fallback;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value)]
  );
}

// 合并内置默认源与用户配置：用户配置里 enabled=false 的源被禁用；key 相同覆盖字段；新增自定义源追加
function mergeSources(defaults, stored) {
  if (!Array.isArray(stored) || !stored.length) return defaults;
  const out = [];
  for (const d of defaults) {
    const hit = stored.find(s => s && s.key === d.key);
    if (hit) {
      if (hit.enabled === false) continue; // 用户关闭
      out.push({ ...d, ...hit, enabled: true });
    } else {
      out.push({ ...d, enabled: true });
    }
  }
  for (const s of stored) {
    if (s && s.enabled !== false && s.key && !defaults.some(d => d.key === s.key)) {
      out.push(s); // 用户自定义源
    }
  }
  return out;
}

module.exports = { getSetting, setSetting, mergeSources, ensureSettingsTable };
