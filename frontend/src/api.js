// api.js - 统一请求封装
export async function request(path, opts = {}) {
  const res = await fetch('/api' + path, {
    credentials: 'include',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || ('请求失败 ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: JSON.stringify(body || {}) }),
  put: (p, body) => request(p, { method: 'PUT', body: JSON.stringify(body || {}) }),
  del: (p) => request(p, { method: 'DELETE' })
};

// Bangumi 图片统一走服务器代理
export function img(u) {
  if (!u) return '';
  if (u.startsWith('/api/img')) return u;
  if (/^https?:\/\//.test(u)) return '/api/img?u=' + encodeURIComponent(u);
  return u;
}

export const SUBJECT_TYPES = { 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' };
export const COLLECT_STATUS = { 1: '想看', 2: '看过', 3: '在看', 4: '搁置', 5: '抛弃' };
export const STATUS_COLOR = { 1: 'info', 2: 'success', 3: 'warning', 4: 'default', 5: 'error' };

// 话数显示：S1E20 这类季-集格式直接展示，其余显示为「第 X 话」
export function episodeLabel(ep) {
  if (!ep) return '';
  const str = String(ep);
  if (/^S\d{1,2}E\d{1,3}$/i.test(str)) return str;
  if (/^(?:第|全).+话$/.test(str)) return str;
  return '第 ' + str + ' 话';
}

export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  return d.toLocaleDateString('zh-CN');
}

export function scoreText(score) {
  if (!score) return '';
  return score.toFixed ? score.toFixed(1) : String(score);
}

// 收藏标签：兼容数组 / JSON 字符串 / 逗号分隔文本
export function parseTags(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === 'string') {
    try {
      const a = JSON.parse(v);
      if (Array.isArray(a)) return a;
    } catch (e) { /* ignore */ }
    return v.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}