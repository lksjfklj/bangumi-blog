// logger.js - 轻量结构化日志：按天轮转文件 + 控制台输出
// 日志目录 backend/logs/，文件 app-YYYY-MM-DD.log，JSON Lines 格式，自动清理 14 天前旧日志
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const KEEP_DAYS = 14;

function pad(n) { return String(n).padStart(2, '0'); }
function dateStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function writeFile(level, msg, fields) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      msg: String(msg).slice(0, 2000),
      ...(fields || {})
    });
    fs.appendFileSync(path.join(LOG_DIR, 'app-' + dateStamp() + '.log'), line + '\n', 'utf8');
  } catch (e) { /* 日志写入失败不影响主流程 */ }
}

function cleanupOld() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = f.match(/^app-(\d{4}-\d{2}-\d{2})\.log$/);
      if (m && new Date(m[1] + 'T00:00:00').getTime() < cutoff) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
}

function emit(level, msg, fields) {
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  if (level === 'error') console.error('[' + level + ']', msg, extra);
  else if (level === 'warn') console.warn('[' + level + ']', msg, extra);
  else console.log('[' + level + ']', msg, extra);
  writeFile(level, msg, fields);
}

module.exports = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  log: (msg, fields) => emit('info', msg, fields),
  cleanupOld
};
