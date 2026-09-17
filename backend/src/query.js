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

module.exports = { strParam, clampInt, paging, escapeLike, LIKE_ESC, MAX_PAGE };
