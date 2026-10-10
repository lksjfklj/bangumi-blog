// query.js - 请求参数安全解析
//
// 为什么需要它：Express 的 req.query 完全由用户控制，取值形态可能是
//   字符串 "1"、数组 ["1","2"]（?a=1&a=2、?tag[]=x、?tag[a]=x）、空串、超长串。
// 直接写 +req.query.size 会踩三个坑：
//   1) +'abc' / +[..] === NaN，Math.min(NaN, 50) 仍是 NaN；node:sqlite 绑定
//      NaN/Infinity/小数/超出 int64 的数一律抛 `datatype mismatch` -> 500。
//   2) 负数绕过上限：SQLite 的 `LIMIT -1` 表示「不限制」，`?size=-1` 会把整表拉出来。
//   3) ?tag[]=a 传进来是数组，直接绑定同样抛错。
// 因此所有分页/数量参数都必须经 clampInt / strParam 归一化后再进 SQL。

// 取字符串参数：数组只取第一个元素，对象/undefined 回退默认值
function strParam(v, def = '') {
  let x = v;
  if (Array.isArray(x)) x = x.length ? x[0] : undefined;
  if (x === undefined || x === null) return def;
  if (typeof x === 'object' || typeof x === 'boolean') return def;
  return String(x);
}

// 取整数参数并夹进 [min, max]；空串/非法值/非有限数一律回退 def
function clampInt(v, def, min, max) {
  const s = strParam(v, '').trim();
  if (s === '') return def;
  const n = Math.trunc(Number(s));
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// 分页参数的统一上限：page 再大也只是翻到超出范围的空页，这里限死避免
// offset 溢出 int64（1e21 之类同样会让 SQLite 抛 datatype mismatch）
const MAX_PAGE = 1000000;

// 解析「第几页 + 每页多少」，两者都已夹好范围，offset 直接可用
function paging(query, { defSize = 10, maxSize = 50, defPage = 1 } = {}) {
  const size = clampInt(query.size, defSize, 1, maxSize);
  const page = clampInt(query.page, defPage, 1, MAX_PAGE);
  return { page, size, limit: size, offset: (page - 1) * size };
}

// LIKE 模糊查询的通配符转义（必须配合 SQL 里的 ESCAPE '\' 使用，
// 否则用户搜 "100%" 会退化成「100 开头的所有内容」）
function escapeLike(s) {
  return strParam(s).replace(/[\\%_]/g, c => '\\' + c);
}

// 配合 escapeLike 使用：SQLite 的 LIKE ... ESCAPE 需要显式告诉它哪个是转义符。
// 放在这里集中定义，路由里就不用再写容易出错的反斜杠字面量。
const LIKE_ESC = "ESCAPE '\\'";

// 路径/请求体里的自增 id：只接受纯十进制正整数。
// 旧写法 +req.params.id 会把 '1e309' 变 Infinity、'1.5' 变 1.5、'abc' 变 NaN 直接塞进 SQL，
// 返回 0 表示"非法"，调用方应当直接回 400 而不是继续查库。
function parseId(v) {
  const s = strParam(Array.isArray(v) ? v[0] : v, '').trim();
  return /^[1-9]\d{0,14}$/.test(s) ? Number(s) : 0;
}

// 昵称一类短文本：控制字符/换行会破坏页面布局，也便于伪装成"多行官方回复"，
// 统一折成单行后截断
function cleanName(v, max = 40) {
  return strParam(v, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// SQLite 的 CURRENT_TIMESTAMP 存的是 UTC 文本（YYYY-MM-DD HH:MM:SS）。
// 直接丢给浏览器 new Date() 会被当成本地时间解析（东八区早 8 小时，跨零点还会差一天），
// 统一补成带 Z 的 ISO 再返回给前端。
function toIsoUtc(s) {
  if (!s) return null;
  const t = String(s);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) return t.replace(' ', 'T') + 'Z';
  return t;
}

// 请求体里的发布标志只认 0/1。客户端可能把草稿送来字符串 "0"（表单/curl/老前端），
// 那种形态在 `published ? 1 : 0` 里是真值，会把草稿直接发出去。
function toPublished(v, def = 1) {
  if (v === undefined || v === null || v === '') return def;
  return +v === 1 ? 1 : 0;
}

// slug 会直接拼进 /blog/<slug>、RSS 的 <link> 和 sitemap：空白折成 -，去掉首尾 - 与控制字符。
// 中文保留（前端统一 encodeURIComponent 后再拼 URL），不做音译。
function normSlug(v, max = 200) {
  return strParam(v, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

// 返回空串表示合法。/ \ ? # % 会把 /blog/<slug> 截断或破坏 RSS/sitemap 的 XML，
// 宁可在这里报 400 也不要存进库里生成一个打不开的链接。
function slugError(s) {
  if (!s) return 'slug 不能为空';
  if (/[\/\\?#%]/.test(s)) return 'slug 不能包含 / \\ ? # % 这些字符';
  return '';
}

module.exports = { strParam, clampInt, paging, escapeLike, LIKE_ESC, MAX_PAGE, parseId, cleanName, toIsoUtc, toPublished, normSlug, slugError };
