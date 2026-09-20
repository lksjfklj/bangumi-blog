// librarydate.js - 「最新一卷 / 最新发售日」的归一化与匹配（纯函数，便于单测）
//
// 背景：本地内容库的 air_date 来自 Bangumi 列表接口的 date 字段，对书籍而言它是「系列首卷首发日」
//       （剑风传奇 = 1990-11-26、SLAM DUNK 完全版 = 2001-03-19），拿它排「近期注目」只能排出老经典。
//       书籍 tab 要按「最新一卷」排，可用的免费信号有两个：
//         1) bgm 的 sort=date 新登载流（bookrelease 每 6h 扫近 105 天窗口）里条目名自带卷号，
//            剥掉卷号后能与库内系列名对上 —— stripVolumeSuffix / seriesKey / seriesKeysOf；
//         2) VNDB 回填写进 library_subjects.ext.vndb.released 的作品发售日（Galgame 用）—— normalizeDate。
//       本模块只做纯字符串/日期处理，落库与排序分别在 bookrelease.js 与 library.js。

// 全角 -> 半角（（4）/４/＃/Ｖｏｌ 等统一成半角形式，下面正则可以只写一套）
function nfkc(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return typeof s.normalize === 'function' ? s.normalize('NFKC') : s;
}

// 卷号后缀（在 NFKC 归一化之后匹配）
const VOL_SUFFIX_RES = [
  // 冒険者酒場の料理人 (4) / (第4巻) / [12] / 【第3巻】の例は安全阀那侧有说明
  /[\s\u3000]*[([]\s*(?:第\s*)?\d{1,3}\s*(?:巻|卷|集|冊|册|話|话)?\s*[)\]]\s*$/,
  // 諸星大二郎短編集成 第12集 月童（卷号后面还挂着副标题，一起丢掉）
  /[\s\u3000]*第\s*\d{1,3}\s*(?:巻|卷|集|冊|册|話|话).*$/,
  // Harley Quinn in Paradise Vol. 3 / Vol.03 / Volume 12
  /[\s\u3000]*vol(?:ume)?\.?\s*\d{1,3}\s*$/i,
  // 作品名 #12
  /[\s\u3000]*#\s*\d{1,3}\s*$/,
  // 進撃の巨人 34巻 / 12集
  /[\s\u3000]*\d{1,3}\s*(?:巻|卷|集|冊|册)\s*$/,
  // 進撃の巨人 34（空格分隔的裸卷号）
  /[\s\u3000]+\d{1,3}\s*$/
];

// 「名字里还有真实文字」的判据：字母（含中日韩）/数字
const HAS_WORD_RE = /[\p{L}\p{N}]/u;

// 剥掉条目名末尾的卷号，得到「系列名」。
// 只处理明确的卷号写法，不做「末尾有数字就砍」以外的猜测：
// 剥不干净只会漏配（少一条 latest_date），剥错才会把不相关作品串成一条，所以宁可保守。
function stripVolumeSuffix(name) {
  const raw = nfkc(name).trim();
  let t = raw;
  for (let round = 0; round < 3; round++) {
    const before = t;
    for (const re of VOL_SUFFIX_RES) {
      const next = t.replace(re, '').trim();
      // 安全阀：剥完连一个字母/数字都不剩，说明这次匹配把整个名字都当成卷号吃掉了
      // （例如「【第3巻】進撃の巨人」这种把卷号写在开头的写法），宁可保留原样让它匹配不上，
      // 也不能留一个「【」这样的残渣当真名 —— 残渣越短越容易和别的作品撞成一条系列。
      if (HAS_WORD_RE.test(next)) t = next;
    }
    if (t === before) break;
  }
  return t;
}

// 归一化键：NFKC + 小写 + 去空白 + 去标点/符号，让「同一系列的不同写法」
// （・/·/：/-/【】/！ 等混用、中英日名混杂）能对上同一个键。
// 空名、纯符号、归一化后不足 2 字、以及「不含任何字母」（纯数字如卷号残渣「12」「2024」，
// 含中日韩文字以外的情况）一律返回 ''，调用方直接跳过 —— 这种谁都能撞上的键一旦进匹配，
// 会把不相关作品串成一条系列，互相污染发售日。
function seriesKey(name) {
  const t = stripVolumeSuffix(name)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
  return t.length >= 2 && /\p{L}/u.test(t) ? t : '';
}

// 一次取条目多个名字（原名/中文名）的可用匹配键，去重
function seriesKeysOf(...names) {
  const out = new Set();
  for (const n of names) {
    const k = seriesKey(n);
    if (k) out.add(k);
  }
  return [...out];
}

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
function pad2(n) { return n < 10 ? '0' + n : String(n); }

function buildDate(y, m, d) {
  if (!Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR) return '';
  if (!Number.isInteger(m) || !Number.isInteger(d)) return '';
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  // 回读校验：挡掉 2 月 30 日这类不存在的日期（Date 会顺延到 3 月，比较后即不相等）
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  return y + '-' + pad2(m) + '-' + pad2(d);
}

// 日期归一化：Bangumi（多为 YYYY-MM-DD，也有只到年的）与 VNDB（YYYY / YYYY-MM / YYYY-MM-DD / 'TBA'）混合。
// 只到年/年月时补到月初：排序上仍落在正确年份，不会把「不知道具体哪天」错记成别的时间。
// 认不出（TBA、空、乱码）返回 ''，调用方视为「没有已知发售日」。
function normalizeDate(value) {
  const s = nfkc(value).trim().replace(/[/.]/g, '-');
  const m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : 1;
  const d = m[3] ? Number(m[3]) : 1;
  return buildDate(y, mo, d);
}

// 取两个日期里更晚的一个（无效日期视为不存在）。用于「只增不减」地回写 latest_date：
// 同一系列被多条日历行命中、或旧卷重扫时，不会把已经记录的新卷日期冲掉。
function latestDate(a, b) {
  const x = normalizeDate(a);
  const y = normalizeDate(b);
  if (!x) return y;
  if (!y) return x;
  return x >= y ? x : y;
}

module.exports = {
  stripVolumeSuffix,
  seriesKey,
  seriesKeysOf,
  normalizeDate,
  latestDate,
  MIN_YEAR,
  MAX_YEAR
};
