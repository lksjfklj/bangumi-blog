// title.js - 番剧资源标题解析：字幕组 / 番名 / 话数 / 清晰度
// 用于 RSS 聚合的按番分组、话数标签与 Bangumi 匹配

function toHalf(s) {
  return String(s).replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

function norm(s) {
  return toHalf(String(s)).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

// 画质/编码/来源/容器 等技术标记（删除前先记住，避免残留 -DL/-KAF 这类碎片）
const QUALITY_RE = /\b(?:2160p|1440p|1080p|1080i|720p|480p|360p|4k|8k|uhd)\b|\b(?:hevc|h\.?265|x265|x264|h\.?264|avc|aac|flac|ac3|eac3|opus|mp3|10bit|8bit|yuv420|hi10p|ma10p)\b|\b(?:bdrip|bd|bluray|blu-ray|webrip|web[- ]?dl|webm|tvrip|dvdrip|hdtv|dvd|remux|raw|mux)\b|\b(?:mp4|mkv|avi|ts|m2ts|flv|wmv)\b/gi;

// 画质提取：优先显式分辨率标记，其次 wxh 分辨率（1920x1080 -> 1080P）
function pickQuality(raw) {
  const t = String(raw || '');
  let m = t.match(/\b(?:2160p|1440p|1080p|1080i|720p|480p|360p|4k|8k|uhd)\b/i);
  if (m) return m[0].toUpperCase();
  m = t.match(/\b(\d{3,4})x(\d{3,4})\b/);
  if (m) {
    const h = +m[2];
    if (h >= 2160) return '2160P';
    if (h >= 1080) return '1080P';
    if (h >= 720) return '720P';
    if (h >= 480) return '480P';
  }
  return '';
}

const META_RE = /简繁|简中|繁中|简体|繁体|简日|繁日|双语|雙語|中字|内嵌|内封|外挂|字幕|字幕组|修复|重压|合集|全话|全集|完結|完结|最終话|最终话|アニメ|\bend\b|\bova\b|\boad\b|\bsp\b|[0-9０-９]{1,2}\s*月新番/gi;

// 季号标记：第X季 / 第X期 / Season X / S2（注意不要吞 S2E5，先处理 SxE）
const SEASON_RE = /第\s*[0-9０-９一二三四五六七八九十]+\s*[季期]|\b(?:season|s)[ .]?[0-9]+\b/gi;

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000, 万: 10000 };
function cnToNum(s) {
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  let total = 0, cur = 0;
  for (const ch of String(s)) {
    if (ch === '十') { cur = (cur || 1) * 10; total += cur; cur = 0; }
    else if (ch === '百' || ch === '千' || ch === '万') { cur = (cur || 1) * (CN_NUM[ch] || 1); total += cur; cur = 0; }
    else if (CN_NUM[ch]) cur += CN_NUM[ch];
    else return NaN;
  }
  return total + cur;
}

const EP_RE = [
  /第\s*([0-9０-９一二三四五六七八九十百千万]+)\s*[话話集回卷]/
  ,/\b(?:episode|ep)\s*[.]?\s*([0-9]{1,4})\b/i,
  /(?:^|[. _-])[eE][pP]?[. _-]?([0-9]{1,4})(?=[. _-]|$)/,   // E1176 / Ep 08 / .E21.
  /[eE][pP][ .]?([0-9]{1,3})/,
  /[\[【]([0-9]{1,4})(?:\.5)?(?:v[0-9])?[\]】]/,   // [03] / 【1176】（One Piece 长连播）
  /(?:^|[\s\-_・])([0-9]{1,3})(?:\.5)?(?:v[0-9])?(?=[\s\-_・]|$)/
];

function extractEpisode(raw) {
  let t = toHalf(String(raw || ''));
  // 隐藏季号标记与 SxE 前缀，避免把 Season 2 / 第2期 / S2E5 的季号当作话数
  t = t.replace(/[Ss]\d{1,2}[Ee]\d{1,3}/g, ' ')
    .replace(SEASON_RE, ' ');
  for (const re of EP_RE) {
    const m = t.match(re);
    if (!m) continue;
    const v = cnToNum(m[1]);
    if (!isNaN(v) && v >= 1 && v <= 2000) return String(v);
  }
  return '';
}

function extractSubGroup(raw) {
  const t = String(raw || '').trim();
  // 只取第一个方括号块，且块内不允许再出现 [（避免 [a][b] 被吞）
  const m = t.match(/^[\[【]([^\[【\]】]*)[\]】]/);
  if (m) {
    const cleaned = m[1].replace(/\d+月新番|新番|合集|字幕组|&amp;/gi, '').replace(/&/g, '&').trim();
    if (cleaned && cleaned.length <= 24) return cleaned;
  }
  return '';
}

// 方括号块是否为「话数/画质/编码/字幕」等技术标记（是则删除，否则保留为番名的一部分）
function classifyBracket(inner) {
  const b = String(inner || '').trim();
  if (!b) return true;
  if (/^\d{1,4}(?:\.5)?(?:v\d+)?$/.test(b)) return true; // [03] [1176]
  if (/^(?:ova|oad|sp|pv|cm|mv|ncop|nced)$/i.test(b)) return true;
  if (/(?:2160p|1440p|1080p|1080i|720p|480p|360p|4k|8k|uhd|hevc|h\.?265|x265|x264|h\.?264|avc|aac|flac|ac3|eac3|opus|mp3|10bit|8bit|yuv420|hi10p|ma10p|bdrip|webrip|webdl|hdtv|dvdrip|remux|raw|mkv|mp4|avi|ts|m2ts|flv|wmv|chs|cht|jpn|baha|cr|abema|简繁|简中|繁中|简体|繁体|简日|繁日|双语|雙語|中字|内嵌|内封|外挂|字幕|修复|重压|合集|月新番)/i.test(b)) return true;
  return false;
}

// 括号内容若为「画质/编码/来源/字幕」信息则整组剔除。
// 注意不能写 (?=...)，lookahead 是零宽断言，匹配后位置回退导致 [）)] 永远匹配失败。
const PAREN_QUAL_RE = /[（(][^（）()]*(?:p\b|1080|720|2160|4k|hevc|x26|avc|aac|flac|cr\b|baha|abema|web|bd\b|字幕|简|繁|中字|mkv|mp4|ts\b)[^（）()]*[）)]/gi;

// Nyaa 等站点标题里的「检索用：别名」括号，纯搜索辅助信息，直接剔除
const SEARCH_HINT_RE = /[（(]\s*检索用\s*[:：][^（）()]*[)）]/gi;

function parseTitle(raw) {
  let t = toHalf(String(raw || '')).replace(/_/g, ' ').trim();
  if (!t) return { seriesTitle: '', episode: '', subGroup: '', quality: '' };
  const subGroup = extractSubGroup(t);
  const quality = pickQuality(t);
  const episode = extractEpisode(t);
  // 删除第一个方括号块（字幕组，已提取到 subGroup）
  t = t.replace(/^[\[【][^\[【\]】]*[\]】]\s*/, ' ');
  // 其余方括号块：技术标记删，番名保留（去掉括号）
  t = t.replace(/[\[【]([^\[【\]】]*)[\]】]/g, (m, inner) => classifyBracket(inner) ? ' ' : inner);
  t = t.replace(QUALITY_RE, ' ').replace(META_RE, ' ').trim();
  // 剔除开头的 ★07月新番★ 这类装饰星号（保留番名中间的 ★，如 Black★Rock Shooter）
  t = t.replace(/^[★☆\s]+/, ' ').replace(/[★☆]+(?=\s|$)/g, ' ');
  // 剔除「画质/来源」类括号内容与检索用括号
  t = t.replace(PAREN_QUAL_RE, ' ').replace(SEARCH_HINT_RE, ' ').trim();
  // 剥离季号标记（避免 Season 2 残留；S01E31 这种已整体删除）
  t = t.replace(SEASON_RE, ' ').replace(/[Ss]\d{1,2}[Ee]\d{1,3}/g, ' ');
  // 剔除话数标记与孤立话数数字（避免误删年份 4 位数）
  t = t.replace(/第\s*[0-9０-９一二三四五六七八九十百千万]+\s*[话話集回卷]/g, ' ')
    .replace(/\s*[eE][pP][ .]?[0-9]{1,3}\s*/gi, ' ')
    .replace(/(^|\s|\.)[eE][pP]?[ .]?[0-9]{1,4}(?=\s|\.|$)/gi, ' ')
    .replace(/(^|\s)[0-9]{1,3}(?:\.5)?(?:v[0-9])?(?=\s|$)/g, ' ')
    .replace(/\b(?:episode|ep)\b/gi, ' ')
    .replace(/\s+[0-9A-Fa-f]{6,}\s*$/g, ' ')
    .trim();
  // 清理空括号与多余分隔符
  t = t.replace(/[（(]\s*[)）]/g, ' ').replace(/\s*[-_・]\s*[-_・]*/g, ' ').replace(/\s+/g, ' ').trim();
  return { seriesTitle: t, episode, subGroup, quality };
}

// 去季号后的番名（用于系列聚合 key）
function stripSeason(title) {
  return String(title)
    .replace(SEASON_RE, '')
    .replace(/[Ss]\d{1,2}[Ee]\d{1,3}/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
}

// 繁->简（仅用于 Bangumi 标题匹配；opencc-js 加载失败时退化为原样）
let _t2s = null;
try {
  const OpenCC = require('opencc-js');
  _t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });
} catch (e) { _t2s = null; }
const T2S_EXTRA = { '\u59b3': '\u4f60' }; // 妳 -> 你（opencc 不处理）
function toSimplified(s) {
  let t = String(s || '');
  if (_t2s) t = _t2s(t);
  for (const k in T2S_EXTRA) if (t.includes(k)) t = t.split(k).join(T2S_EXTRA[k]);
  return t;
}
function snorm(s) { return norm(toSimplified(s)); }

module.exports = { parseTitle, extractEpisode, extractSubGroup, norm, stripSeason, toHalf, toSimplified, snorm };
